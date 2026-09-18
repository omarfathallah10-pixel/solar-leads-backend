import { logger } from '../lib/logger';
import { prisma } from '../lib/prisma';
import { introQueue } from '../queues';

/**
 * Reconciliation. Runs every 10 minutes.
 *
 * Distributed systems drop things: a process dies between COMMIT and enqueue,
 * Redis restarts, a deploy kills a worker mid-send. This is the cheap insurance
 * that catches it. Enqueueing is safe to repeat because jobId is deterministic
 * and the partial unique index still holds the database side.
 */
export async function reconcileOutreach(): Promise<{ requeued: number; stuck: number }> {
  // --- Queued for >5 minutes with no live job: re-enqueue -------------------
  const orphaned = await prisma.outreachMessage.findMany({
    where: {
      status: 'queued',
      createdAt: { lt: new Date(Date.now() - 5 * 60_000) },
    },
    select: { id: true, leadId: true, messageType: true },
    take: 500,
  });

  let requeued = 0;
  for (const msg of orphaned) {
    const jobId = `${msg.messageType}:${msg.leadId}`;
    const existing = await introQueue.getJob(jobId);
    if (existing) continue;

    await introQueue.add('send-intro', { messageId: msg.id }, {
      jobId,
      attempts: 5,
      backoff: { type: 'exponential', delay: 60_000 },
    });
    requeued++;
  }

  // --- Stuck in 'sending' for >30 minutes ----------------------------------
  // Deliberately NOT auto-retried. The worker died mid-send and we cannot know
  // whether the message actually went out. Sending a second copy to a cold
  // prospect is worse than a human spending two minutes checking the mailbox.
  const stuck = await prisma.outreachMessage.findMany({
    where: { status: 'sending', createdAt: { lt: new Date(Date.now() - 30 * 60_000) } },
    select: { id: true, toEmail: true, sendingIdentityId: true },
  });

  if (stuck.length > 0) {
    logger.error(
      { count: stuck.length, ids: stuck.map((s) => s.id) },
      'MESSAGES STUCK IN SENDING — manual review required, do not auto-retry',
    );
  }

  if (requeued > 0) logger.warn({ requeued }, 'reconciliation re-enqueued orphaned messages');
  return { requeued, stuck: stuck.length };
}
