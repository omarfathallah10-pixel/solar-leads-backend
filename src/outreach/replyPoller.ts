import { pollMailboxReplies } from '../email/providers';
import { logger } from '../lib/logger';
import { prisma } from '../lib/prisma';
import { introQueue } from '../queues';

/**
 * Reply detection.
 *
 * Replies are the metric that actually matters, and no ESP webhook reports
 * them. This polls each Graph mailbox and matches inbound messages back to the
 * intro we sent, by conversationId first (exact) then by sender address.
 *
 * Two things happen on a match, and the second one matters more than it looks:
 *   1. The lead advances to 'engaged'.
 *   2. Every scheduled follow-up for that lead is CANCELLED. Nothing damages a
 *      prospect relationship faster than an automated follow-up arriving after
 *      they already replied.
 */

const LOOKBACK_MINUTES = 15; // overlap the 5-minute schedule so nothing slips

export async function pollAllMailboxesForReplies(): Promise<{ matched: number }> {
  const identities = await prisma.sendingIdentity.findMany({
    where: { isActive: true, provider: 'msgraph' },
  });

  const since = new Date(Date.now() - LOOKBACK_MINUTES * 60_000);
  let matched = 0;

  for (const identity of identities) {
    let replies;
    try {
      replies = await pollMailboxReplies(identity.mailboxEmail, since);
    } catch (err) {
      // One unreachable mailbox must not stop the others.
      logger.warn({ err, mailbox: identity.mailboxEmail }, 'reply poll failed');
      continue;
    }

    for (const reply of replies) {
      const message = await findMatchingMessage(reply.conversationId, reply.fromEmail);
      if (!message) continue;
      if (message.repliedAt) continue; // already recorded

      await prisma.$transaction(async (tx) => {
        await tx.emailEvent.create({
          data: {
            messageId: message.id,
            eventType: 'reply',
            occurredAt: new Date(reply.receivedAt),
            // Unique — a repeated poll of the same inbox is a no-op.
            providerEventId: `graph:reply:${reply.graphMessageId}`,
            payload: {
              subject: reply.subject,
              preview: reply.preview,
              from: reply.fromEmail,
            } as object,
          },
        });

        await tx.outreachMessage.update({
          where: { id: message.id },
          data: { status: 'replied', repliedAt: new Date(reply.receivedAt) },
        });

        await tx.lead.update({
          where: { id: message.leadId },
          data: { status: 'engaged' },
        });
      }).catch((err) => {
        // Unique violation on providerEventId = duplicate poll. Expected.
        logger.debug({ err, messageId: message.id }, 'reply already recorded');
      });

      // Cancel pending follow-ups for this lead.
      for (const suffix of ['followup_1', 'followup_2']) {
        await introQueue.remove(`${suffix}:${message.leadId}`).catch(() => undefined);
      }
      await prisma.outreachMessage.updateMany({
        where: {
          leadId: message.leadId,
          messageType: { in: ['followup_1', 'followup_2'] },
          status: 'queued',
        },
        data: { status: 'cancelled' },
      });

      matched++;
      logger.info(
        { messageId: message.id, leadId: message.leadId, from: reply.fromEmail },
        'reply detected — follow-ups cancelled',
      );
    }
  }

  return { matched };
}

async function findMatchingMessage(
  conversationId: string | null,
  fromEmail: string | null,
): Promise<{ id: string; leadId: string; repliedAt: Date | null } | null> {
  // conversationId is Graph's own thread handle — exact, and stored at send time.
  if (conversationId) {
    const byConversation = await prisma.outreachMessage.findFirst({
      where: { graphConversationId: conversationId },
      select: { id: true, leadId: true, repliedAt: true },
    });
    if (byConversation) return byConversation;
  }

  // Fallback: sender address. Weaker (a person may reply from an alias, or the
  // thread may have been forwarded), so it is scoped to messages we actually
  // sent to that address and to the most recent one.
  if (fromEmail) {
    return prisma.outreachMessage.findFirst({
      where: { toEmail: fromEmail, status: { in: ['sent', 'delivered', 'opened'] } },
      orderBy: { sentAt: 'desc' },
      select: { id: true, leadId: true, repliedAt: true },
    });
  }

  return null;
}
