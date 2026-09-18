import area from '@turf/area';
import { env } from '../config/env';
import { fetchJson, RateLimiter } from '../lib/http';
import { logger } from '../lib/logger';
import { recordUsage } from './usageLedger';

/**
 * OpenStreetMap discovery via Overpass.
 *
 * This is the highest-leverage free data source for a solar company: it returns
 * every industrial building, warehouse, hotel and marina in a region *as a
 * polygon*, from which roof area falls out for nothing.
 *
 * Etiquette: public Overpass instances are volunteer-run. We serialise requests
 * at one every 3 seconds and send a descriptive User-Agent. For country-scale
 * extracts use a Geofabrik .pbf download instead of hammering the API.
 *
 * Licensing: OSM data is ODbL. Fine for internal analysis; share-alike
 * obligations attach if you redistribute a derived database externally.
 */

const limiter = new RateLimiter(3000);

export type DiscoverySectorKey =
  | 'industrial' | 'logistics' | 'hospitality' | 'marine' | 'real_estate' | 'existing_solar';

/** OSM selectors per target sector. `nwr` matches nodes, ways and relations. */
export const SECTOR_SELECTORS: Record<DiscoverySectorKey, string[]> = {
  industrial: [
    'way["building"="industrial"]',
    'way["landuse"="industrial"]',
    'way["man_made"="works"]',
    'way["industrial"="factory"]',
  ],
  logistics: [
    'way["building"="warehouse"]',
    'way["landuse"="logistics"]',
    'way["building"="distribution_centre"]',
  ],
  hospitality: [
    'nwr["tourism"~"^(hotel|resort|guest_house)$"]',
    'way["building"="hotel"]',
  ],
  marine: [
    'nwr["leisure"="marina"]',
    'nwr["industrial"="shipyard"]',
    'nwr["seamark:type"="harbour"]',
  ],
  real_estate: [
    'way["building"~"^(commercial|office|retail)$"]',
    'way["building"="apartments"]',
  ],
  // Competitive mapping: who already has solar.
  existing_solar: [
    'nwr["power"="plant"]["plant:source"="solar"]',
    'nwr["generator:source"="solar"]',
  ],
};

export interface BoundingBox {
  south: number;
  west: number;
  north: number;
  east: number;
}

export interface OverpassElement {
  type: 'node' | 'way' | 'relation';
  id: number;
  lat?: number;
  lon?: number;
  center?: { lat: number; lon: number };
  geometry?: Array<{ lat: number; lon: number }>;
  tags?: Record<string, string>;
}

/**
 * A building footprint and a land parcel are completely different objects, and
 * conflating them was a real bug: `landuse=industrial` returns the whole site
 * boundary, so Tura Cement's 49-hectare parcel was measured as a roof and
 * scored as a 54 MWp rooftop system.
 *
 *   'building' → roof area, rooftop economics, ~5.5 m² per kWp
 *   'land'     → site boundary, ground-mount economics, ~18 m² per kWp,
 *                and a different sales conversation entirely
 */
export type GeometryKind = 'building' | 'land';

export interface DiscoveredSite {
  osmId: string;
  name: string | null;
  sectorKey: DiscoverySectorKey;
  geometryKind: GeometryKind;
  latitude: number;
  longitude: number;
  /** GeoJSON Polygon, when the element had a closed way geometry. */
  footprintGeojson: GeoJSON.Polygon | null;
  /** m², computed locally from the polygon. Zero external cost. */
  areaM2: number | null;
  website: string | null;
  phone: string | null;
  address: string | null;
  city: string | null;
  tags: Record<string, string>;
}

function buildQuery(bbox: BoundingBox, selectors: string[], timeoutSec = 120): string {
  const box = `${bbox.south},${bbox.west},${bbox.north},${bbox.east}`;
  const body = selectors.map((s) => `  ${s}(${box});`).join('\n');
  // `out geom` returns the full node list per way, which is what lets us
  // compute roof area without a single paid API call.
  return `[out:json][timeout:${timeoutSec}];\n(\n${body}\n);\nout geom tags;`;
}

/** Converts an Overpass way geometry into a closed GeoJSON polygon. */
function toPolygon(geometry: Array<{ lat: number; lon: number }>): GeoJSON.Polygon | null {
  if (geometry.length < 3) return null;
  const ring: number[][] = geometry.map((p) => [p.lon, p.lat]);
  const first = ring[0]!;
  const last = ring[ring.length - 1]!;
  if (first[0] !== last[0] || first[1] !== last[1]) ring.push([first[0]!, first[1]!]);
  if (ring.length < 4) return null;
  return { type: 'Polygon', coordinates: [ring as GeoJSON.Position[]] };
}

/**
 * A `building` tag means a structure with a roof. Anything keyed on `landuse`
 * is a parcel boundary. `man_made=works` is ambiguous in OSM — sometimes a
 * building, sometimes a whole plant — so it is treated as land, which is the
 * safe direction: a ground-mount estimate on a roof understates the
 * opportunity, while a roof estimate on a parcel overstates it by 10x.
 */
function classifyGeometry(tags: Record<string, string>): GeometryKind {
  if (tags.building && tags.building !== 'no') return 'building';
  return 'land';
}

/**
 * Things that are physically plausible but commercially wrong.
 *
 * A power station has enormous land and enormous consumption, and scores at the
 * very top — but it is a utility, not a customer. Same for existing solar farms
 * and substations. Filtering them here keeps the top of the pipeline credible,
 * which matters more than it sounds: a rep who opens the pipeline and sees a
 * national power plant as lead #1 stops trusting the score.
 */
const NON_CUSTOMER = (tags: Record<string, string>): boolean =>
  tags.power !== undefined ||
  tags['plant:source'] !== undefined ||
  tags['generator:source'] !== undefined ||
  tags.man_made === 'substation' ||
  tags.landuse === 'quarry';

/**
 * Names that are plot designators rather than companies — "بلوك 5", "Block 12",
 * "Plot 7". They are zoning labels on an industrial block, and the real leads
 * are the individual buildings inside them.
 */
const NOT_A_COMPANY_NAME = (name: string): boolean =>
  /^\s*(بلوك|قطعة|مجاورة|block|plot|lot|parcel|zone|sector)\s*[0-9\u0660-\u0669]*\s*$/iu.test(name);

function centroidOf(el: OverpassElement): { lat: number; lon: number } | null {
  if (el.lat != null && el.lon != null) return { lat: el.lat, lon: el.lon };
  if (el.center) return el.center;
  if (el.geometry?.length) {
    const n = el.geometry.length;
    const sum = el.geometry.reduce(
      (acc, p) => ({ lat: acc.lat + p.lat, lon: acc.lon + p.lon }),
      { lat: 0, lon: 0 },
    );
    return { lat: sum.lat / n, lon: sum.lon / n };
  }
  return null;
}

export async function discoverSites(
  bbox: BoundingBox,
  sectorKey: DiscoverySectorKey,
  opts: { minAreaM2?: number; maxRoofAreaM2?: number } = {},
): Promise<DiscoveredSite[]> {
  const selectors = SECTOR_SELECTORS[sectorKey];
  const query = buildQuery(bbox, selectors);

  const data = await limiter.schedule(() =>
    fetchJson<{ elements: OverpassElement[] }>(env.OVERPASS_ENDPOINT, {
      label: `overpass:${sectorKey}`,
      method: 'POST',
      body: new URLSearchParams({ data: query }).toString(),
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      timeoutMs: 180_000,
      retries: 2,
    }),
  );

  await recordUsage({ provider: 'overpass', sku: 'query' });

  const minArea = opts.minAreaM2 ?? 0;
  const results: DiscoveredSite[] = [];
  const skipped = { nonCustomer: 0, implausibleRoof: 0, plotLabel: 0, tooSmall: 0 };

  for (const el of data.elements ?? []) {
    const centre = centroidOf(el);
    if (!centre) continue;

    const polygon = el.geometry ? toPolygon(el.geometry) : null;
    // @turf/area returns square metres on the WGS84 spheroid.
    const areaM2 = polygon ? Math.round(area(polygon)) : null;

    // Filter out sheds and kiosks. A 200 m² "industrial building" is not a lead.
    if (minArea > 0 && (areaM2 ?? 0) < minArea) {
      skipped.tooSmall++;
      continue;
    }

    const tags = el.tags ?? {};

    // Utilities and quarries score at the top and are not customers.
    if (NON_CUSTOMER(tags) && sectorKey !== 'existing_solar') {
      skipped.nonCustomer++;
      continue;
    }

    const kind = classifyGeometry(tags);

    // A single industrial roof effectively never exceeds ~40,000 m². Anything
    // larger tagged as a building is a mis-tagged parcel, and treating it as a
    // roof produces a system size an order of magnitude too big.
    if (kind === 'building' && areaM2 !== null && areaM2 > (opts.maxRoofAreaM2 ?? 40_000)) {
      skipped.implausibleRoof++;
      continue;
    }

    const name = tags.name ?? tags['name:en'] ?? tags.operator ?? null;
    if (name && NOT_A_COMPANY_NAME(name)) {
      skipped.plotLabel++;
      continue;
    }

    results.push({
      osmId: `${el.type}/${el.id}`,
      name,
      sectorKey,
      geometryKind: classifyGeometry(tags),
      latitude: centre.lat,
      longitude: centre.lon,
      footprintGeojson: polygon,
      areaM2,
      website: tags.website ?? tags['contact:website'] ?? null,
      phone: tags.phone ?? tags['contact:phone'] ?? null,
      address: [tags['addr:street'], tags['addr:housenumber']].filter(Boolean).join(' ') || null,
      city: tags['addr:city'] ?? null,
      tags,
    });
  }

  logger.info(
    {
      sectorKey,
      returned: data.elements?.length ?? 0,
      kept: results.length,
      buildings: results.filter((r) => r.geometryKind === 'building').length,
      landParcels: results.filter((r) => r.geometryKind === 'land').length,
      skipped,
    },
    'overpass discovery complete',
  );
  return results;
}
