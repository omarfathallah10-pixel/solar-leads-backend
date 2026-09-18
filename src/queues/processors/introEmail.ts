import { Job, UnrecoverableError } from 'bullmq';
import { assertFullyRendered, renderTemplate } from '../../email/render';
import { getProvider } from '../../email/providers';
import { unsubscribeUrl } from '../../email/unsubscribe';
import { isPermanent } from '../../lib/errors';
import { logger } from '../../lib/logger';
import { prisma } from '../../lib/prisma';
import { buildTemplateVars } from '../../outreach/personalization';
import type { IntroEmailJob } from '../index';

const TERMINAL_STATUSES = new Set(['sent', 'delivered', 'opened', 'replied', 'cancelled']);

export async function processIntroEmail(job: Job<IntroEmailJob>): Promise<unknown> {
  const { messageId } = job.data;

  const message = await prisma.outreachMessage.findUnique({
    where: { id: messageId },
    include: {
      template: true,
      sendingIdentity: true,
      contact: true,
      lead: { include: { company: { include: { sector: true } }, site: true, sector: true } },
    },
  });

  if (!message) throw new UnrecoverableError(`Message ${messageId} not found`);

  // A retry landed on an already-processed message. Not an error.
  if (TERMINAL_STATUSES.has(message.status)) {
    logger.info({ messageId, status: message.status }, 'already processed; skipping');
    return { skipped: true };
  }

  try {
    // ---- Last-moment suppression re-check ---------------------------------
    // Suppression can be added between approval and send: someone forwards the
    // first email internally and a colleague unsubscribes on their behalf.
    const suppressed = await prisma.suppressionEntry.findFirst({
      where: {
        OR: [
          { email: message.toEmail },
          ...(message.lead.company.domain ? [{ domain: message.lead.company.domain }] : []),
        ],
      },
    });
    if (suppressed) {
      await prisma.outreachMessage.update({
        where: { id: messageId },
        data: { status: 'suppressed', lastError: `Suppressed: ${suppressed.reason}` },
      });
      throw new UnrecoverableError('Recipient suppressed after approval');
    }

    // ---- Render ------------------------------------------------------------
    const site = message.lead.site;
    const vars = buildTemplateVars({
      firstName: message.contact.firstName,
      companyName: message.lead.company.name,
      city: site?.city ?? message.lead.company.hqCity ?? null,
      sectorKey: message.lead.sector?.key ?? 'industrial_general',
      painPoints: message.lead.sector?.painPoints,
      roofAreaM2: site?.roofAreaM2 ? Number(site.roofAreaM2) : null,
      estimatedKwp: site?.estimatedKwp ? Number(site.estimatedKwp) : null,
      estimatedAnnualMwh: site?.estimatedAnnualMwh ? Number(site.estimatedAnnualMwh) : null,
      senderName: message.sendingIdentity.displayName,
      unsubscribeUrl: unsubscribeUrl({ messageId, email: message.toEmail }),
    });

    const subject = renderTemplate(message.template.subjectTemplate, vars);
    const body = renderTemplate(message.template.bodyTemplate, vars);

    assertFullyRendered(subject, 'subject');
    assertFullyRendered(body, 'body');

    await prisma.outreachMessage.update({
      where: { id: messageId },
      data: {
        status: 'sending',
        subjectRendered: subject,
        bodyRendered: body,
        attemptCount: { increment: 1 },
      },
    });

    // ---- Send --------------------------------------------------------------
    const provider = getProvider(message.sendingIdentity.provider);
    const result = await provider.send({
      from: {
        email: message.sendingIdentity.mailboxEmail,
        name: message.sendingIdentity.displayName,
      },
      to: message.toEmail,
      subject,
      text: body,
      correlationId: messageId,
      headers: {
        'X-Lead-Id': message.leadId,
      },
    });

    await prisma.$transaction([
      prisma.outreachMessage.update({
        where: { id: messageId },
        data: {
          status: 'sent',
          sentAt: new Date(),
          providerMessageId: result.providerMessageId,
          rfc822MessageId: result.rfc822MessageId,
          graphConversationId: result.conversationId,
          lastError: null,
        },
      }),
      prisma.lead.update({
        where: { id: message.leadId },
        data: { status: 'contacted' },
      }),
    ]);

    logger.info({ messageId, leadId: message.leadId }, 'intro email sent');
    return { sent: true, providerMessageId: result.providerMessageId };
  } catch (err) {
    const permanent = err instanceof UnrecoverableError || isPermanent(err);
    const errorText = String(err instanceof Error ? err.message : err).slice(0, 1000);

    await prisma.outreachMessage.update({
      where: { id: messageId },
      data: {
        // Only mark 'failed' on a permanent error. A transient failure must stay
        // in 'sending' so the partial unique index keeps holding the slot and no
        // parallel path can create a second intro row for this contact.
        ...(permanent && !TERMINAL_STATUSES.has(message.status)
          ? { status: 'failed' as const }
          : {}),
        lastError: errorText,
      },
    }).catch((e) => logger.error({ e, messageId }, 'failed to record send error'));

    logger.error({ messageId, permanent, err: errorText }, 'intro send failed');

    if (permanent) throw new UnrecoverableError(errorText);
    throw err; // transient: BullMQ exponential backoff 1m → 2m → 4m → 8m → 16m
  }
}
