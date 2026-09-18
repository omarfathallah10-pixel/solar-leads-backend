import { Worker } from 'bullmq';
import { logger } from './lib/logger';
import { disconnectPrisma } from './lib/prisma';
import { closeRedis, connection } from './lib/redis';
import { reconcileOutreach } from './outreach/reconcile';
import { pollAllMailboxesForReplies } from './outreach/replyPoller';
import { closeQueues, QUEUE_NAMES } from './queues';
import { processDiscovery } from './queues/processors/discovery';
import { processEnrichment } from './queues/processors/enrichment';
import { processIntroEmail } from './queues/processors/introEmail';
import { processScoring } from './queues/processors/scoring';

/**
 * Worker process. Run separately from the API so a long enrichment run cannot
 * make the dashboard unresponsive, and so the two can scale independently.
 */

const workers = [
  // Discovery is serialised: public Overpass instances are volunteer-run and
  // parallel requests are how you get your IP blocked.
  new Worker(QUEUE_NAMES.discovery, processDiscovery, {
    connection, concurrency: 1, limiter: { max: 1, duration: 5_000 },
  }),

  // Enrichment is I/O-bound against third-party APIs. This limiter is the
  // real throughput ceiling of the whole pipeline, not the database.
  new Worker(QUEUE_NAMES.enrichment, processEnrichment, {
    connection, concurrency: 4, limiter: { max: 60, duration: 60_000 },
  }),

  // Scoring is pure CPU arithmetic and a couple of queries. Cheap.
  new Worker(QUEUE_NAMES.scoring, processScoring, {
    connection, concurrency: 8,
  }),

  // Global email throttle. Per-mailbox DAILY caps are enforced separately in
  // SQL at approval time: this limiter protects the provider API, the daily cap
  // protects domain reputation. Both are needed; neither replaces the other.
  new Worker(QUEUE_NAMES.introEmail, processIntroEmail, {
    connection, concurrency: 3, limiter: { max: 30, duration: 60_000 },
  }),
];

for (const worker of workers) {
  worker.on('failed', (job, err) => {
    logger.error(
      { queue: worker.name, jobId: job?.id, attempts: job?.attemptsMade, err: err.message },
      'job failed',
    );
  });
  worker.on('completed', (job) => {
    logger.debug({ queue: worker.name, jobId: job.id }, 'job completed');
  });
}

// --- Scheduled tasks -------------------------------------------------------
// setInterval rather than repeatable BullMQ jobs, on purpose: with a single
// worker process this is simpler to reason about. If you scale to multiple
// worker replicas, move these to repeatable jobs so they do not run N times.
const intervals: NodeJS.Timeout[] = [
  setInterval(() => {
    pollAllMailboxesForReplies().catch((err) => logger.error({ err }, 'reply poll failed'));
  }, 5 * 60_000),

  setInterval(() => {
    reconcileOutreach().catch((err) => logger.error({ err }, 'reconciliation failed'));
  }, 10 * 60_000),
];

logger.info({ queues: workers.map((w) => w.name) }, 'worker started');

async function shutdown(signal: string): Promise<void> {
  logger.info({ signal }, 'shutting down worker');
  for (const timer of intervals) clearInterval(timer);
  // Graceful close lets in-flight jobs finish rather than leaving messages
  // stranded in 'sending'.
  await Promise.all(workers.map((w) => w.close()));
  await closeQueues();
  await disconnectPrisma();
  await closeRedis();
  process.exit(0);
}

process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));
