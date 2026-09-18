export const clamp01 = (n: number): number => Math.max(0, Math.min(1, n));

/** Linear normalisation with saturation at both ends. */
export function scale(value: number, min: number, max: number): number {
  if (max <= min) return 0;
  return clamp01((value - min) / (max - min));
}

/**
 * Log-scaled normalisation. Used for system capacity because the perceived
 * difference between 50 and 500 kWp is far larger than between 4,550 and
 * 5,000 kWp. Linear scaling crams every mid-size lead into the bottom decile.
 */
export function logScale(value: number, min: number, max: number): number {
  if (min <= 0 || max <= min) return 0;
  if (value <= min) return 0;
  if (value >= max) return 1;
  return clamp01(Math.log(value / min) / Math.log(max / min));
}

/** ~5.5 m² per kWp with current commercial modules, mounted flat on a roof. */
export const ROOF_M2_PER_KWP = 5.5;

/**
 * Ground mount needs roughly 3x the land per kWp of a rooftop: rows have to be
 * spaced to avoid self-shading, plus access tracks, inverter stations and
 * setbacks. Using the rooftop figure on a land parcel overstates capacity by
 * about 3x on top of whatever the parcel-vs-roof confusion already cost.
 */
export const GROUND_M2_PER_KWP = 18;

export function estimateKwp(
  roofAreaM2: number,
  usableRoofFactor: number,
  m2PerKwp = ROOF_M2_PER_KWP,
): number {
  return (roofAreaM2 * usableRoofFactor) / m2PerKwp;
}

/** performanceRatio covers soiling, temperature, inverter and cabling losses. */
export function estimateAnnualMwh(
  kwp: number,
  ghiKwhM2Day: number,
  performanceRatio = 0.78,
): number {
  return (kwp * ghiKwhM2Day * 365 * performanceRatio) / 1000;
}

/** Haversine great-circle distance in kilometres. */
export function haversineKm(
  a: { lat: number; lon: number },
  b: { lat: number; lon: number },
): number {
  const R = 6371;
  const dLat = ((b.lat - a.lat) * Math.PI) / 180;
  const dLon = ((b.lon - a.lon) * Math.PI) / 180;
  const lat1 = (a.lat * Math.PI) / 180;
  const lat2 = (b.lat * Math.PI) / 180;
  const h =
    Math.sin(dLat / 2) ** 2 + Math.sin(dLon / 2) ** 2 * Math.cos(lat1) * Math.cos(lat2);
  return 2 * R * Math.asin(Math.sqrt(h));
}
