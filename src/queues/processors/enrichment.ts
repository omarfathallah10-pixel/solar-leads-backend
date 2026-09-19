import { Job, UnrecoverableError } from 'bullmq';
import { attachContactToLeads, ensureLeadForSite } from '../../enrichment/createLead';
import { enrichCompanyFromWeb, enrichSite } from '../../enrichment/enrichSite';
import { enrichCompanyContactWithOpenAI } from '../../enrichment/openaiEnricher';
import { BudgetExceededError } from '../../lib/errors';
import { logger } from '../../lib/logger';
import { prisma } from '../../lib/prisma';
import { jobId, scoringQueue, type EnrichmentJob } from '../index';

export async function processEnrichment(job: Job<EnrichmentJob>): Promise<unknown> {
  const { siteId, companyId } = job.data;

  try {
    if (siteId) await enrichSite(siteId);
    if (companyId) await enrichCompanyFromWeb(companyId);
    // Paid LLM fallback: only reached when the free scrape above found no
    // contact at all. Runs before attachContactToLeads below so a contact it
    // creates gets linked to a waiting lead in the same pass.
    if (companyId) await enrichCompanyContactWithOpenAI(companyId);
  } catch (err) {
    // The budget breaker tripping is not a job failure to retry — it is a
    // deliberate stop. Retrying would just burn the queue against a closed gate.
    if (err instanceof BudgetExceededError) {
      logger.error({ err: err.message }, 'enrichment halted: API budget exceeded');
      throw new UnrecoverableError(err.message);
    }
    throw err;
  }

  // Create the lead this site represents, if it does not exist yet. Without
  // this step the pipeline screen has nothing to show — discovery produces
  // buildings, and a building only becomes a lead here.
  if (siteId) await ensureLeadForSite(siteId);

  // A contact found by the website scraper has to be attached to an existing
  // contactless lead, or the pipeline fills with un-emailable rows.
  if (companyId) await attachContactToLeads(companyId);

  // Re-score every lead touched by this enrichment.
  const leads = await prisma.lead.findMany({
    where: {
      OR: [
        ...(siteId ? [{ siteId }] : []),
        ...(companyId ? [{ companyId }] : []),
      ],
    },
    select: { id: true },
  });

  for (const lead of leads) {
    await scoringQueue.add(
      'score-lead',
      { leadId: lead.id },
      { jobId: jobId('score', lead.id, Date.now()), attempts: 2 },
    );
  }

  return { siteId, companyId, rescored: leads.length };
}