import { Job } from 'bullmq';
import { scoreAndPersist } from '../../scoring';
import type { ScoringJob } from '../index';

export async function processScoring(job: Job<ScoringJob>): Promise<unknown> {
  const result = await scoreAndPersist(job.data.leadId, { force: job.data.force });
  return result
    ? { score: result.score, band: result.band, coverage: result.coverage }
    : { skipped: 'inputs unchanged' };
}
