import { Prisma } from '@prisma/client';
import { env } from '../config/env';
import { logger } from '../lib/logger';
import { isUniqueViolation, prisma } from '../lib/prisma';
import { introQueue } from '../queues';

export type ApprovalCode =
  | 'OK' | 'NOT_FOUND' | 'NO_CONTACT' | 'SUPPRESSED' | 'INVALID_EMAIL'
  | 'NO_LAWFUL_BASIS' | 'NO_TEMPLATE' | 'CAPACITY' | 'BELOW_THRESHOLD'
  | 'ALREADY_CONTACTED';

export type ApprovalResult =
  | { ok: true; messageId: string }
  | { ok: false; code: ApprovalCode; reason: string };

/**
 * Approves a lead for an introductory email.
 *
 * Idempotent and concurrency-safe. Calling this twice — from two browser tabs,
 * two workers, or a rerun backfill script — inserts exactly one row and returns
 * ALREADY_CONTACTED the second time.
 *
 * ⚠ The guarantee comes from the partial unique indexes in migration.sql, NOT
 *   from the checks below. The checks exist to produce a good error message;
 *   the index exists to be correct. Never "optimise" by removing either.
 */
export async function approveLeadForOutreach(params: {
  leadId: string;
  approvedByUserId: string;
  campaignId?: string;
  scheduledFor?: Date;
  /** Set by the auto-approval job; a human approver may go below threshold. */
  enforceScoreThreshold?: boolean;
}): Promise<ApprovalResult> {
  const idempotencyKey = `intro:${params.leadId}`;
  let createdMessageId: string | null = null;

  try {
    const outcome = await prisma.$transaction(async (tx): Promise<ApprovalResult> => {
      // Serialise concurrent approvals of the same lead. Two tabs clicking
      // Approve simultaneously now queue behind each other rather than both
      // sailing through the checks.
      await tx.$executeRaw`SELECT id FROM leads WHERE id = ${params.leadId}::uuid FOR UPDATE`;

      const lead = await tx.lead.findUnique({
        where: { id: params.leadId },
        include: { contact: true, company: true },
      });

      if (!lead) {
        return { ok: false, code: 'NOT_FOUND' as const, reason: 'Lead not found.' };
      }
      if (!lead.contact?.email) {
        return {
          ok: false, code: 'NO_CONTACT' as const,
          reason: 'Lead has no contact with an email address.',
        };
      }

      if (
        params.enforceScoreThreshold &&
        Number(lead.currentScore ?? 0) < env.MIN_SCORE_FOR_AUTO_APPROVAL
      ) {
        return {
          ok: false, code: 'BELOW_THRESHOLD' as const,
          reason: `Score ${lead.currentScore ?? 0} is below the auto-approval threshold ` +
            `of ${env.MIN_SCORE_FOR_AUTO_APPROVAL}.`,
        };
      }

      // ---- Gate 1: suppression, by address OR by whole domain --------------
      const suppressed = await tx.suppressionEntry.findFirst({
        where: {
          OR: [
            { email: lead.contact.email },
            ...(lead.company.domain ? [{ domain: lead.company.domain }] : []),
          ],
        },
      });
      if (suppressed) {
        await tx.lead.update({
          where: { id: params.leadId },
          data: { status: 'suppressed' },
        });
        return {
          ok: false, code: 'SUPPRESSED' as const,
          reason: `Suppressed: ${suppressed.reason}`,
        };
      }

      // ---- Gate 2: deliverability -----------------------------------------
      if (lead.contact.emailStatus === 'invalid') {
        return {
          ok: false, code: 'INVALID_EMAIL' as const,
          reason: 'Email verified invalid — sending would bounce and hurt domain reputation.',
        };
      }

      // ---- Gate 3: lawful basis -------------------------------------------
      // Refuses to send without a recorded basis. This is the control that
      // makes the compliance story enforceable rather than aspirational.
      const consent = await tx.consentRecord.findFirst({
        where: {
          subjectEmail: lead.contact.email,
          withdrawnAt: null,
          OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }],
        },
        orderBy: { establishedAt: 'desc' },
      });
      if (!consent || consent.basis === 'not_established') {
        return {
          ok: false, code: 'NO_LAWFUL_BASIS' as const,
          reason: 'No lawful basis recorded for contacting this person.',
        };
      }

      // ---- Template selection: most specific sector match wins -------------
      const template = await tx.emailTemplate.findFirst({
        where: {
          isActive: true,
          language: lead.contact.languagePref ?? 'en',
          OR: [{ sectorId: lead.sectorId }, { sectorId: null }],
        },
        orderBy: [{ sectorId: 'desc' }, { version: 'desc' }],
      });
      if (!template) {
        return {
          ok: false, code: 'NO_TEMPLATE' as const,
          reason: 'No active template for this sector/language combination.',
        };
      }

      // ---- Sending identity: least-loaded mailbox still under its cap ------
      const identity = await pickSendingIdentity(tx);
      if (!identity) {
        return {
          ok: false, code: 'CAPACITY' as const,
          reason: 'All sending mailboxes are at their daily cap. Try again tomorrow.',
        };
      }

      // ---- The insert that enforces "one intro, ever" ----------------------
      const message = await tx.outreachMessage.create({
        data: {
          leadId: params.leadId,
          contactId: lead.contact.id,
          campaignId: params.campaignId ?? null,
          templateId: template.id,
          templateVersion: template.version,
          sendingIdentityId: identity.id,
          messageType: 'intro',
          status: 'queued',
          idempotencyKey,
          toEmail: lead.contact.email,
          scheduledFor: params.scheduledFor ?? new Date(),
        },
      });

      await tx.lead.update({
        where: { id: params.leadId },
        data: {
          status: 'approved',
          approvedAt: new Date(),
          approvedBy: params.approvedByUserId,
        },
      });

      await tx.auditLog.create({
        data: {
          actorId: params.approvedByUserId,
          action: 'lead.approved',
          entityType: 'lead',
          entityId: params.leadId,
          diff: {
            score: lead.currentScore?.toString() ?? null,
            messageId: message.id,
            mailbox: identity.mailboxEmail,
          } as object,
        },
      });

      return { ok: true as const, messageId: message.id };
    });

    if (!outcome.ok) return outcome;
    createdMessageId = outcome.messageId;
  } catch (err) {
    // A unique violation here is the EXPECTED outcome of a duplicate approval.
    // It satisfies the caller's intent, so it is not logged as an error.
    if (isUniqueViolation(err)) {
      logger.info({ leadId: params.leadId }, 'duplicate approval blocked by unique index');
      return {
        ok: false,
        code: 'ALREADY_CONTACTED',
        reason: 'This lead has already received an introductory email.',
      };
    }
    throw err;
  }

  // Enqueue AFTER the transaction commits. If this throws, the reconciliation
  // job picks up any 'queued' row older than 5 minutes — see reconcile.ts.
  await introQueue.add(
    'send-intro',
    { messageId: createdMessageId },
    {
      jobId: idempotencyKey, // BullMQ collapses duplicate jobIds: second dedupe layer
      delay: params.scheduledFor
        ? Math.max(0, params.scheduledFor.getTime() - Date.now())
        : 0,
      attempts: 5,
      backoff: { type: 'exponential', delay: 60_000 }, // 1m, 2m, 4m, 8m, 16m
      removeOnComplete: { age: 86_400 },
      removeOnFail: false, // keep failures visible in Bull Board
    },
  );

  return { ok: true, messageId: createdMessageId };
}

/**
 * Least-loaded active mailbox that is still under its self-imposed daily cap.
 *
 * The cap is reputation protection, not a provider limit: Exchange Online will
 * happily accept thousands per day, and that is exactly how a domain gets
 * filtered. Scale by adding mailboxes, not by raising the cap.
 */
async function pickSendingIdentity(
  tx: Prisma.TransactionClient,
): Promise<{ id: string; mailboxEmail: string } | null> {
  const rows = await tx.$queryRaw<Array<{ id: string; mailbox_email: string }>>(Prisma.sql`
    SELECT si.id, si.mailbox_email
      FROM sending_identities si
      LEFT JOIN outreach_messages m
        ON m.sending_identity_id = si.id
       AND m.sent_at >= date_trunc('day', now())
     WHERE si.is_active
     GROUP BY si.id, si.mailbox_email, si.daily_cap
    HAVING COUNT(m.id) < si.daily_cap
     ORDER BY COUNT(m.id) ASC
     LIMIT 1
  `);

  const row = rows[0];
  return row ? { id: row.id, mailboxEmail: row.mailbox_email } : null;
}
