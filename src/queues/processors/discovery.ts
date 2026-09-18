import { Job } from 'bullmq';
import { ingestDiscoveredSites } from '../../enrichment/ingest';
import { discoverSites, type DiscoverySectorKey } from '../../enrichment/overpass';
import { logger } from '../../lib/logger';
import { prisma } from '../../lib/prisma';
import { enrichmentQueue, jobId, type DiscoveryJob } from '../index';

export async function processDiscovery(job: Job<DiscoveryJob>): Promise<unknown> {
  const { bbox, sectorKey, minAreaM2 } = job.data;

  const sites = await discoverSites(bbox, sectorKey as DiscoverySectorKey, {
    // Default floor filters out sheds and kiosks. A 200 m² "industrial
    // building" is not a solar lead.
    minAreaM2: minAreaM2 ?? 500,
  });

  const summary = await ingestDiscoveredSites(sites, 'osm');

  // Fan out enrichment for everything newly created. Deterministic jobIds mean
  // re-running discovery over an overlapping bbox does not double-enrich.
  const newSites = await prisma.companySite.findMany({
    where: { roofAreaConfidence: { in: ['medium', 'absent'] }, ghiKwhM2Day: null },
    select: { id: true, companyId: true },
    take: 2000,
  });

  for (const site of newSites) {
    await enrichmentQueue.add(
      'enrich-site',
      { siteId: site.id },
      { jobId: jobId('site', site.id), attempts: 3, backoff: { type: 'exponential', delay: 30_000 } },
    );
    await enrichmentQueue.add(
      'enrich-company',
      { companyId: site.companyId },
      { jobId: jobId('company', site.companyId), attempts: 2, backoff: { type: 'exponential', delay: 30_000 } },
    );
  }

  logger.info({ sectorKey, ...summary, queued: newSites.length }, 'discovery job complete');
  return summary;
}