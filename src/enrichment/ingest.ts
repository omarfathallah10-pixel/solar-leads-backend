import { Prisma } from '@prisma/client';
import { env } from '../config/env';
import { logger } from '../lib/logger';
import { prisma } from '../lib/prisma';
import { haversineKm } from '../scoring/math';
import { findExistingCompany, normalizeCompanyName, normalizeDomain } from './dedupe';
import type { DiscoveredSite } from './overpass';

/**
 * Stage 1 → 2: turn raw OSM/Overture discoveries into Company + CompanySite
 * rows, deduplicating as we go.
 *
 * Deliberately does NOT create Leads. A site with no contact is not a lead —
 * it is a qualified building waiting for a contact. Leads are created in the
 * contact-discovery stage, which only runs on sites that already score well.
 */

/** Maps our discovery categories onto seeded sector keys. */
const SECTOR_KEY_MAP: Record<string, string> = {
  industrial: 'industrial_general',
  logistics: 'logistics_warehouse',
  hospitality: 'hospitality_hotel',
  marine: 'marine_marina',
  real_estate: 'real_estate_commercial',
  existing_solar: 'utility_scale_epc',
};

export interface IngestSummary {
  discovered: number;
  companiesCreated: number;
  companiesMatched: number;
  sitesCreated: number;
  sitesSkipped: number;
}

export async function ingestDiscoveredSites(
  sites: DiscoveredSite[],
  source: string,
): Promise<IngestSummary> {
  const summary: IngestSummary = {
    discovered: sites.length,
    companiesCreated: 0,
    companiesMatched: 0,
    sitesCreated: 0,
    sitesSkipped: 0,
  };

  for (const site of sites) {
    // An unnamed polygon cannot be turned into a company. Skip rather than
    // create "Unnamed industrial building #4821" rows that pollute the pipeline.
    if (!site.name) {
      summary.sitesSkipped++;
      continue;
    }

    try {
      const sectorKey = SECTOR_KEY_MAP[site.sectorKey] ?? 'industrial_general';
      const sector = await prisma.sector.findUnique({ where: { key: sectorKey } });
      const domain = normalizeDomain(site.website);

      const match = await findExistingCompany({
        name: site.name,
        domain,
        latitude: site.latitude,
        longitude: site.longitude,
      });

      let companyId: string;
      if (match) {
        companyId = match.id;
        summary.companiesMatched++;
      } else {
        const company = await prisma.company.create({
          data: {
            name: site.name,
            normalizedName: normalizeCompanyName(site.name),
            domain,
            website: site.website,
            sectorId: sector?.id ?? null,
            hqCity: site.city,
            hqAddress: site.address,
            hqLatitude: site.latitude,
            hqLongitude: site.longitude,
            externalIds: { osm_id: site.osmId },
          },
        });
        companyId = company.id;
        summary.companiesCreated++;
      }

      // Idempotency: re-running discovery over the same bbox must not create
      // duplicate sites. OSM ids are stable, so key on them.
      const existingSite = await prisma.companySite.findFirst({
        where: { companyId, label: site.osmId },
        select: { id: true },
      });
      if (existingSite) {
        summary.sitesSkipped++;
        continue;
      }

      const distanceKm = haversineKm(
        { lat: env.OPS_BASE_LAT, lon: env.OPS_BASE_LON },
        { lat: site.latitude, lon: site.longitude },
      );

      const created = await prisma.companySite.create({
        data: {
          companyId,
          label: site.osmId,
          siteType: site.geometryKind === 'land' ? 'land' : site.sectorKey,
          address: site.address,
          city: site.city,
          latitude: site.latitude,
          longitude: site.longitude,
          // Prisma rejects a bare `null` for a nullable Json column; DbNull is
          // the SQL NULL, JsonNull would write the JSON literal `null`.
          footprintGeojson: site.footprintGeojson
            ? (site.footprintGeojson as unknown as Prisma.InputJsonValue)
            : Prisma.DbNull,
          // A building polygon is a ROOF. A landuse polygon is a SITE BOUNDARY.
          // They go in different columns because they imply different systems,
          // different densities and a different sales conversation. Putting a
          // 49-hectare parcel in roofAreaM2 produced a 54 MWp "rooftop" system.
          ...(site.geometryKind === 'building'
            ? {
                roofAreaM2: site.areaM2 ?? null,
                roofAreaSource: site.areaM2 ? 'osm_polygon' : null,
                roofAreaConfidence: site.areaM2 ? ('medium' as const) : ('absent' as const),
              }
            : {
                groundAreaM2: site.areaM2 ?? null,
                // Deliberately 'low': a parcel boundary tells you the site is
                // big, not how much of it is actually buildable.
                roofAreaConfidence: 'low' as const,
              }),
          distanceFromBaseKm: distanceKm,
        },
      });

      await prisma.rawSourceRecord.create({
        data: {
          entityType: 'site',
          entityId: created.id,
          sourceKey: source,
          sourceUrl: `https://www.openstreetmap.org/${site.osmId}`,
          license: 'ODbL',
          raw: { tags: site.tags, osmId: site.osmId } as object,
        },
      });

      summary.sitesCreated++;
    } catch (err) {
      // One bad polygon must not abort a 2,000-site import.
      logger.warn({ err, osmId: site.osmId }, 'failed to ingest discovered site');
      summary.sitesSkipped++;
    }
  }

  logger.info(summary, 'discovery ingest complete');
  return summary;
}
