import { Prisma } from '@prisma/client';
import { prisma } from '../lib/prisma';

/**
 * Company deduplication.
 *
 * Rule 1: exact match on normalised domain wins outright.
 * Rule 2: fuzzy name match ONLY within a geographic radius. Never dedupe on
 *         name alone — "Delta Group" exists in every country, and merging two
 *         real companies is far more damaging than creating a duplicate.
 */

const LEGAL_SUFFIXES =
  /\b(s\.?a\.?e\.?|l\.?l\.?c\.?|ltd|limited|inc|incorporated|gmbh|b\.?v\.?|s\.?a\.?r\.?l\.?|plc|co|company|corp|corporation|group|holdings?|est|establishment)\b/gi;

export function normalizeCompanyName(name: string): string {
  return name
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')  // strip diacritics
    .replace(LEGAL_SUFFIXES, ' ')
    .replace(/[^a-z0-9\u0600-\u06ff\s]/g, ' ') // keep Arabic script
    .replace(/\s+/g, ' ')
    .trim();
}

export function normalizeDomain(input: string | null | undefined): string | null {
  if (!input) return null;
  try {
    const u = new URL(input.startsWith('http') ? input : `https://${input}`);
    return u.hostname.replace(/^www\./i, '').toLowerCase();
  } catch {
    return null;
  }
}

export interface CompanyMatch {
  id: string;
  name: string;
  similarity: number;
  distanceKm: number | null;
  matchedOn: 'domain' | 'name_and_location';
}

export async function findExistingCompany(args: {
  name: string;
  domain?: string | null;
  latitude?: number | null;
  longitude?: number | null;
  radiusKm?: number;
  minSimilarity?: number;
}): Promise<CompanyMatch | null> {
  const domain = normalizeDomain(args.domain);

  if (domain) {
    const byDomain = await prisma.company.findFirst({
      where: { domain },
      select: { id: true, name: true },
    });
    if (byDomain) {
      return { ...byDomain, similarity: 1, distanceKm: null, matchedOn: 'domain' };
    }
  }

  if (args.latitude == null || args.longitude == null) return null;

  const normalized = normalizeCompanyName(args.name);
  if (normalized.length < 3) return null;

  const radiusM = (args.radiusKm ?? 25) * 1000;
  const minSim = args.minSimilarity ?? 0.55;

  // pg_trgm similarity gated by a PostGIS radius. Raw SQL because Prisma
  // exposes neither similarity() nor ST_DWithin.
  const rows = await prisma.$queryRaw<
    Array<{ id: string; name: string; similarity: number; distance_m: number }>
  >(Prisma.sql`
    SELECT c.id,
           c.name,
           similarity(c.normalized_name, ${normalized}) AS similarity,
           ST_Distance(
             c.hq_location,
             ST_SetSRID(ST_MakePoint(${args.longitude}, ${args.latitude}), 4326)::geography
           ) AS distance_m
      FROM companies c
     WHERE c.hq_location IS NOT NULL
       AND ST_DWithin(
             c.hq_location,
             ST_SetSRID(ST_MakePoint(${args.longitude}, ${args.latitude}), 4326)::geography,
             ${radiusM}
           )
       AND similarity(c.normalized_name, ${normalized}) >= ${minSim}
     ORDER BY similarity DESC
     LIMIT 1
  `);

  const top = rows[0];
  if (!top) return null;

  return {
    id: top.id,
    name: top.name,
    similarity: Number(top.similarity),
    distanceKm: Number(top.distance_m) / 1000,
    matchedOn: 'name_and_location',
  };
}
