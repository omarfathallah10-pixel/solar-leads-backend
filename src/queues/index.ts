import { Queue } from 'bullmq';
import { connection } from '../lib/redis';

// Pure helpers, kept in their own module so they are testable without Redis.
export { digest, jobId } from './jobId';

export const QUEUE_NAMES = {
  discovery: 'discovery',
  enrichment: 'enrichment',
  scoring: 'scoring',
  introEmail: 'intro-email',
  replyPoll: 'reply-poll',
  reconcile: 'reconcile',
} as const;

const defaultJobOptions = {
  removeOnComplete: { age: 86_400, count: 1000 },
  removeOnFail: { age: 7 * 86_400 },
};

export interface DiscoveryJob {
  bbox: { south: number; west: number; north: number; east: number };
  sectorKey: string;
  minAreaM2?: number;
}
export interface EnrichmentJob { siteId?: string; companyId?: string }
export interface ScoringJob { leadId: string; force?: boolean }
export interface IntroEmailJob { messageId: string }

export const discoveryQueue = new Queue<DiscoveryJob>(QUEUE_NAMES.discovery, {
  connection, defaultJobOptions,
});
export const enrichmentQueue = new Queue<EnrichmentJob>(QUEUE_NAMES.enrichment, {
  connection, defaultJobOptions,
});
export const scoringQueue = new Queue<ScoringJob>(QUEUE_NAMES.scoring, {
  connection, defaultJobOptions,
});
export const introQueue = new Queue<IntroEmailJob>(QUEUE_NAMES.introEmail, {
  connection, defaultJobOptions,
});

export async function closeQueues(): Promise<void> {
  await Promise.all([
    discoveryQueue.close(), enrichmentQueue.close(),
    scoringQueue.close(), introQueue.close(),
  ]);
}