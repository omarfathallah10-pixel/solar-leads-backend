import { env } from '../config/env';
import { fetchJson } from '../lib/http';
import { logger } from '../lib/logger';
import { PermanentError } from '../lib/errors';
import { assertWithinBudget, recordUsage } from './usageLedger';

/**
 * Google Solar API — Building Insights.
 *
 * Far better than an OSM polygon: real roof segments with tilt and azimuth,
 * how many panels actually fit, and whether an array is already installed.
 *
 * Cost shape (verify before relying on it): Building Insights has a free
 * monthly cap around 10,000 calls, then tiered billing. Data Layers has a much
 * smaller free cap (~1,000) and is significantly more expensive — we do not
 * call it at all.
 *
 * Coverage is uneven outside the US and Europe. NOT_FOUND is an expected,
 * non-exceptional outcome: the caller falls back to the OSM polygon area.
 */

interface RoofSegmentStats {
  pitchDegrees?: number;
  azimuthDegrees?: number;
  stats?: { areaMeters2?: number };
}

interface SolarPanelConfig {
  panelsCount?: number;
  yearlyEnergyDcKwh?: number;
}

interface BuildingInsightsResponse {
  name?: string;
  center?: { latitude: number; longitude: number };
  imageryQuality?: 'HIGH' | 'MEDIUM' | 'LOW' | 'BASE';
  imageryDate?: { year: number; month: number; day: number };
  solarPotential?: {
    maxArrayPanelsCount?: number;
    maxArrayAreaMeters2?: number;
    maxSunshineHoursPerYear?: number;
    wholeRoofStats?: { areaMeters2?: number };
    roofSegmentStats?: RoofSegmentStats[];
    solarPanelConfigs?: SolarPanelConfig[];
    panelCapacityWatts?: number;
  };
}

export interface RoofMeasurement {
  roofAreaM2: number;
  usableArrayAreaM2: number | null;
  maxPanels: number | null;
  /** kWp implied by Google's own panel layout, not our 5.5 m²/kWp heuristic. */
  impliedKwp: number | null;
  tiltDeg: number | null;
  azimuthDeg: number | null;
  sunshineHoursPerYear: number | null;
  imageryQuality: string | null;
  source: 'google_solar';
  raw: unknown;
}

export async function fetchBuildingInsights(
  latitude: number,
  longitude: number,
  opts: { requiredQuality?: 'HIGH' | 'MEDIUM' | 'LOW' | 'BASE' } = {},
): Promise<RoofMeasurement | null> {
  if (!env.GOOGLE_MAPS_API_KEY) {
    logger.debug('GOOGLE_MAPS_API_KEY not set — skipping Solar API');
    return null;
  }

  await assertWithinBudget();

  const url =
    `https://solar.googleapis.com/v1/buildingInsights:findClosest` +
    `?location.latitude=${latitude.toFixed(6)}` +
    `&location.longitude=${longitude.toFixed(6)}` +
    `&requiredQuality=${opts.requiredQuality ?? 'LOW'}` +
    `&key=${env.GOOGLE_MAPS_API_KEY}`;

  let data: BuildingInsightsResponse;
  try {
    data = await fetchJson<BuildingInsightsResponse>(url, {
      label: 'google_solar:buildingInsights',
      timeoutMs: 20_000,
      retries: 2,
    });
  } catch (err) {
    // NOT_FOUND is normal outside covered regions. Google still counts it
    // toward usage limits, so we record it, then fall back to OSM.
    if (err instanceof PermanentError && err.code === 'HTTP_404') {
      await recordUsage({ provider: 'google_solar', sku: 'buildingInsights' });
      logger.debug({ latitude, longitude }, 'Solar API: no coverage for this location');
      return null;
    }
    throw err;
  }

  await recordUsage({ provider: 'google_solar', sku: 'buildingInsights' });

  const sp = data.solarPotential;
  const roofAreaM2 = sp?.wholeRoofStats?.areaMeters2;
  if (!sp || !roofAreaM2) return null;

  // Take the largest configuration Google produced; that is the ceiling.
  const bestConfig = sp.solarPanelConfigs?.reduce<SolarPanelConfig | null>(
    (best, c) => ((c.panelsCount ?? 0) > (best?.panelsCount ?? 0) ? c : best),
    null,
  );
  const panelWatts = sp.panelCapacityWatts ?? 400;
  const panels = sp.maxArrayPanelsCount ?? bestConfig?.panelsCount ?? null;

  // Largest roof segment drives the representative tilt/azimuth.
  const largestSegment = sp.roofSegmentStats?.reduce<RoofSegmentStats | null>(
    (best, s) => ((s.stats?.areaMeters2 ?? 0) > (best?.stats?.areaMeters2 ?? 0) ? s : best),
    null,
  );

  return {
    roofAreaM2,
    usableArrayAreaM2: sp.maxArrayAreaMeters2 ?? null,
    maxPanels: panels,
    impliedKwp: panels != null ? (panels * panelWatts) / 1000 : null,
    tiltDeg: largestSegment?.pitchDegrees ?? null,
    azimuthDeg: largestSegment?.azimuthDegrees ?? null,
    sunshineHoursPerYear: sp.maxSunshineHoursPerYear ?? null,
    imageryQuality: data.imageryQuality ?? null,
    source: 'google_solar',
    raw: data,
  };
}

/**
 * Building Insights also detects EXISTING arrays. A roof that is already
 * covered is not a lost lead — it is a storage, O&M or repowering lead, and
 * the scoring engine gates on exactly this.
 */
export function detectExistingSolar(raw: unknown): { has: boolean; kwp: number | null } {
  const d = raw as { solarPotential?: { panelCapacityWatts?: number } } & {
    // Field name per current API docs; treat absence as "unknown", not "none".
    solarPanels?: Array<{ yearlyEnergyDcKwh?: number }>;
  };
  const panels = d?.solarPanels;
  if (!Array.isArray(panels) || panels.length === 0) return { has: false, kwp: null };
  const watts = d.solarPotential?.panelCapacityWatts ?? 400;
  return { has: true, kwp: (panels.length * watts) / 1000 };
}
