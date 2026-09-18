import { logger } from '../lib/logger';
import { prisma } from '../lib/prisma';
import { estimateAnnualMwh, estimateKwp, GROUND_M2_PER_KWP } from '../scoring/math';
import { detectExistingSolar, fetchBuildingInsights } from './googleSolar';
import { fetchIrradiance } from './nasaPower';
import { cacheRaw, getCachedRaw } from './usageLedger';

/**
 * Stage 3 — physical measurement. Free-to-cheap, so it runs on EVERY site.
 * The expensive stage (contact discovery) is gated on the score this produces.
 */
export async function enrichSite(siteId: string): Promise<void> {
  const site = await prisma.companySite.findUnique({
    where: { id: siteId },
    include: { company: { include: { sector: true } } },
  });
  if (!site) return;

  const updates: Record<string, unknown> = {};

  // ---- Irradiance: fetch once, cache forever. It is a climate normal. ------
  if (site.ghiKwhM2Day == null) {
    const cached = await getCachedRaw<{ annualGhiKwhM2Day: number }>(
      'site', siteId, 'nasa_power',
    );
    const irradiance = cached ?? (await fetchIrradiance(site.latitude, site.longitude));
    if (irradiance) {
      updates.ghiKwhM2Day = irradiance.annualGhiKwhM2Day;
      updates.ghiSource = 'nasa_power';
      updates.ghiFetchedAt = new Date();
      if (!cached) {
        await cacheRaw({
          entityType: 'site', entityId: siteId, sourceKey: 'nasa_power',
          license: 'public', raw: irradiance,
        });
      }
    }
  }

  // ---- Roof measurement upgrade -------------------------------------------
  // Only call Google Solar when we do not already have a better source. A
  // 'confirmed' manual measurement from a site visit always wins.
  if (site.roofAreaConfidence !== 'confirmed' && site.roofAreaSource !== 'google_solar') {
    const cached = await getCachedRaw<unknown>('site', siteId, 'google_solar', 365);
    let measurement = null;

    if (cached) {
      const existing = detectExistingSolar(cached);
      updates.hasExistingSolar = existing.has;
      if (existing.kwp) updates.existingSolarKwp = existing.kwp;
    } else {
      measurement = await fetchBuildingInsights(site.latitude, site.longitude);
      if (measurement) {
        updates.roofAreaM2 = measurement.roofAreaM2;
        updates.roofAreaSource = 'google_solar';
        updates.roofAreaConfidence = 'high';
        if (measurement.tiltDeg != null) updates.roofTiltDeg = measurement.tiltDeg;
        if (measurement.azimuthDeg != null) updates.roofAzimuthDeg = measurement.azimuthDeg;

        const existing = detectExistingSolar(measurement.raw);
        updates.hasExistingSolar = existing.has;
        if (existing.kwp) updates.existingSolarKwp = existing.kwp;

        await cacheRaw({
          entityType: 'site', entityId: siteId, sourceKey: 'google_solar',
          license: 'proprietary', raw: measurement.raw,
        });
      }
      // measurement === null means no coverage. The OSM polygon area we already
      // stored stands, at 'medium' confidence. That is the designed fallback.
    }
  }

  // ---- Derived figures ----------------------------------------------------
  // These three numbers are also the best email personalisation asset we have:
  // "your Sadat City facility has ~3,800 m² of usable roof, about 690 kWp".
  const roofArea = Number(updates.roofAreaM2 ?? site.roofAreaM2 ?? 0);
  const ghi = Number(updates.ghiKwhM2Day ?? site.ghiKwhM2Day ?? 0);
  const usableFactor = Number(site.company.sector?.usableRoofFactor ?? 0.6);

  // Ground-mount sites derive capacity from land, at land density.
  const groundArea = Number(site.groundAreaM2 ?? 0);
  if (groundArea > 0 && roofArea === 0) {
    const kwp = estimateKwp(groundArea, 0.65, GROUND_M2_PER_KWP);
    updates.estimatedKwp = Math.round(kwp * 100) / 100;
    if (ghi > 0) {
      updates.estimatedAnnualMwh = Math.round(estimateAnnualMwh(kwp, ghi) * 100) / 100;
    }
  } else if (roofArea > 0) {
    const kwp = estimateKwp(roofArea, usableFactor);
    updates.estimatedKwp = Math.round(kwp * 100) / 100;
    if (ghi > 0) {
      updates.estimatedAnnualMwh = Math.round(estimateAnnualMwh(kwp, ghi) * 100) / 100;
    }
  }

  if (Object.keys(updates).length > 0) {
    await prisma.companySite.update({ where: { id: siteId }, data: updates });
    logger.info({ siteId, fields: Object.keys(updates) }, 'site enriched');
  }
}

/** Stage 2 — company-level enrichment from the company's own website. */
export async function enrichCompanyFromWeb(companyId: string): Promise<void> {
  const { enrichFromWebsite } = await import('./websiteScraper');

  const company = await prisma.company.findUnique({ where: { id: companyId } });
  if (!company) return;

  const target = company.website ?? company.domain;
  if (!target) return;

  const result = await enrichFromWebsite(target);
  if (!result) return;

  const metadata = (company.metadata as Record<string, unknown> | null) ?? {};
  if (result.triggerSignals.length > 0) {
    metadata.signals = {
      ...(metadata.signals as object | undefined),
      ...Object.fromEntries(result.triggerSignals.map((s) => [s, true])),
      observedAt: new Date().toISOString(),
    };
  }

  await prisma.company.update({
    where: { id: companyId },
    data: {
      domain: company.domain ?? result.canonicalDomain,
      sustainabilitySignals: result.sustainabilitySignals,
      metadata: metadata as object,
    },
  });

  await cacheRaw({
    entityType: 'company', entityId: companyId, sourceKey: 'website',
    sourceUrl: result.pagesFetched[0], license: 'public', raw: result,
  });

  // Generic mailboxes become contacts only if we have nothing better. They are
  // weak leads but they are free, and info@ often forwards to an owner at SMEs.
  const generic = result.emails.filter((e) =>
    /^(info|contact|sales|admin|hello|enquiries)@/.test(e),
  );
  const best = result.emails[0];

  if (best) {
    const existing = await prisma.contact.findFirst({ where: { email: best } });
    if (!existing) {
      await prisma.contact.create({
        data: {
          companyId,
          email: best,
          emailSource: 'website_scrape',
          emailStatus: 'unverified',
          seniority: generic.includes(best) ? 'unknown' : 'other',
          isPrimary: true,
        },
      });
    }
  }
}
