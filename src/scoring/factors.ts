import {
  clamp01, estimateAnnualMwh, estimateKwp, GROUND_M2_PER_KWP,
  logScale, ROOF_M2_PER_KWP, scale,
} from './math';
import type { FactorResult, ScoringInput } from './types';

export function factorSolarCapacity(input: ScoringInput, weight: number): FactorResult {
  const base = { key: 'solar_capacity_fit', label: 'System size potential', weight };
  const site = input.site;
  const areaM2 = site?.groundAreaM2 ?? site?.roofAreaM2;

  if (!site || !areaM2 || areaM2 <= 0) {
    return {
      ...base, normalized: null, points: 0, confidence: 'absent',
      evidence: 'No roof or land measurement available — enrich this site to improve accuracy.',
    };
  }

  const isGround = site.groundAreaM2 != null && site.groundAreaM2 > 0;
  // Ground mount and rooftop are different economics AND different densities.
  const usableFactor = isGround ? 0.65 : input.sector.usableRoofFactor;
  const kwp = estimateKwp(
    areaM2,
    usableFactor,
    isGround ? GROUND_M2_PER_KWP : ROOF_M2_PER_KWP,
  );

  // Normalise WITHIN the sector's own capacity band. This is what keeps marine
  // and hospitality leads competitive against industrial ones.
  const normalized = logScale(
    kwp,
    input.sector.capacityBandLowKwp,
    input.sector.capacityBandHighKwp,
  );

  const yieldMwh = site.ghiKwhM2Day ? estimateAnnualMwh(kwp, site.ghiKwhM2Day) : null;

  return {
    ...base,
    normalized,
    points: weight * normalized,
    confidence: site.roofAreaConfidence,
    evidence:
      `${Math.round(areaM2).toLocaleString('en-US')} m² ${isGround ? 'of land' : 'roof'} ` +
      `→ approx. ${Math.round(kwp)} kWp` +
      (yieldMwh ? ` (~${Math.round(yieldMwh).toLocaleString('en-US')} MWh/yr)` : '') +
      `. Sector band: ${input.sector.capacityBandLowKwp}–${input.sector.capacityBandHighKwp} kWp. ` +
      `Source confidence: ${site.roofAreaConfidence}.`,
  };
}

export function factorSectorEnergyProfile(input: ScoringInput, weight: number): FactorResult {
  const { loadFactor, daytimeAlignment, key } = input.sector;

  // Daytime alignment is weighted higher than load factor: solar only offsets
  // load that exists while the sun is up.
  const normalized = clamp01(0.4 * loadFactor + 0.6 * daytimeAlignment);

  return {
    key: 'sector_energy_profile',
    label: 'Energy consumption profile',
    weight,
    normalized,
    points: weight * normalized,
    confidence: 'high',
    evidence:
      `${key}: load factor ${loadFactor.toFixed(2)}, ` +
      `${Math.round(daytimeAlignment * 100)}% of consumption falls in solar hours. ` +
      (daytimeAlignment >= 0.75
        ? 'Strong self-consumption match — most generation offsets grid import directly.'
        : daytimeAlignment >= 0.55
          ? 'Moderate match — storage or net metering improves the economics.'
          : 'Evening-weighted load — solar alone offsets a limited share of consumption.'),
  };
}

export function factorIrradiance(input: ScoringInput, weight: number): FactorResult {
  const base = { key: 'irradiance', label: 'Solar resource', weight };
  const ghi = input.site?.ghiKwhM2Day;

  if (ghi == null) {
    return {
      ...base, normalized: null, points: 0, confidence: 'absent',
      evidence: 'Irradiance not yet fetched for this location.',
    };
  }

  // 3.0–6.5 kWh/m²/day spans poor-northern-European to excellent-desert.
  const normalized = scale(ghi, 3.0, 6.5);
  return {
    ...base, normalized, points: weight * normalized, confidence: 'high',
    evidence:
      `GHI ${ghi.toFixed(2)} kWh/m²/day` +
      (ghi >= 5.5 ? ' — excellent solar resource.'
        : ghi >= 4.5 ? ' — good solar resource.'
          : ' — moderate solar resource.'),
  };
}

export function factorGridPain(input: ScoringInput, weight: number): FactorResult {
  const base = { key: 'grid_pain', label: 'Grid reliability & energy cost pressure', weight };
  const site = input.site;
  if (!site) {
    return { ...base, normalized: null, points: 0, confidence: 'absent', evidence: 'No site data.' };
  }

  const parts: number[] = [];
  const notes: string[] = [];

  // gridReliabilityScore is 0..100 where LOWER means a worse grid — which for
  // a solar vendor means a BETTER lead. Hence the inversion.
  if (site.gridReliabilityScore != null) {
    parts.push(clamp01(1 - site.gridReliabilityScore / 100));
    if (site.gridReliabilityScore < 60) notes.push('frequent outages reported in this area');
  }

  if (site.isRemote) {
    parts.push(1);
    notes.push('remote / weak-grid location — likely diesel-dependent');
  } else if (site.kmToGridInfrastructure != null) {
    parts.push(scale(site.kmToGridInfrastructure, 0, 15));
    if (site.kmToGridInfrastructure > 5) {
      notes.push(`${site.kmToGridInfrastructure.toFixed(1)} km from mapped grid infrastructure`);
    }
  }

  if (parts.length === 0) {
    return {
      ...base, normalized: null, points: 0, confidence: 'absent',
      evidence: 'No grid reliability data available for this location.',
    };
  }

  const normalized = parts.reduce((a, b) => a + b, 0) / parts.length;
  return {
    ...base, normalized, points: weight * normalized, confidence: 'medium',
    evidence: notes.length
      ? `Grid pressure signals: ${notes.join('; ')}. Diesel displacement shortens payback materially.`
      : 'Stable grid connection — value case rests on tariff savings rather than reliability.',
  };
}

/**
 * A published net-zero target with a date implies allocated budget.
 * A "green" link in the site footer implies nothing. Weight accordingly.
 */
const SUSTAINABILITY_SIGNAL_VALUES: Record<string, number> = {
  net_zero_target: 0.35,
  renewable_ppa_mentioned: 0.30,
  esg_report: 0.25,
  iso_14001: 0.20,
  leed_or_green_building: 0.20,
  green_certification: 0.12,
  sustainability_page: 0.08,
};

export function factorSustainability(input: ScoringInput, weight: number): FactorResult {
  const base = { key: 'sustainability_mandate', label: 'Sustainability mandate', weight };
  const signals = input.company?.sustainabilitySignals ?? [];

  if (signals.length === 0) {
    return {
      ...base, normalized: 0, points: 0, confidence: 'medium',
      evidence: 'No public sustainability commitments found on the company website.',
    };
  }

  const raw = signals.reduce((sum, s) => sum + (SUSTAINABILITY_SIGNAL_VALUES[s] ?? 0.05), 0);
  const normalized = clamp01(raw);
  return {
    ...base, normalized, points: weight * normalized, confidence: 'medium',
    evidence:
      `Public signals: ${signals.join(', ')}. ` +
      (normalized > 0.6
        ? 'Strong mandate — likely to have budget and an internal sponsor already.'
        : 'Some stated intent; verify whether a budget owner exists.'),
  };
}

export function factorTriggerEvents(input: ScoringInput, weight: number): FactorResult {
  const base = { key: 'trigger_events', label: 'Buying triggers', weight };
  const s = input.signals;

  if (!s) {
    return {
      ...base, normalized: 0, points: 0, confidence: 'low',
      evidence: 'No timing signals detected. Not disqualifying — signal coverage is thin.',
    };
  }

  const hits: Array<[boolean | undefined, number, string]> = [
    [s.publishedTender, 0.45, 'published a relevant tender'],
    [s.constructionPermit, 0.35, 'active construction permit'],
    [s.recentExpansion, 0.30, 'announced expansion'],
    [s.energyRoleHiring, 0.20, 'hiring for an energy/facilities role'],
  ];

  const active = hits.filter(([on]) => on === true);
  let raw = active.reduce((sum, [, v]) => sum + v, 0);

  // Triggers decay. A tender from 14 months ago is history, not a signal.
  if (s.signalObservedAt) {
    const ageMonths = (Date.now() - s.signalObservedAt.getTime()) / (1000 * 60 * 60 * 24 * 30.44);
    raw *= clamp01(1 - ageMonths / 12);
  }

  const normalized = clamp01(raw);
  return {
    ...base, normalized, points: weight * normalized,
    confidence: active.length ? 'medium' : 'low',
    evidence: active.length
      ? `Detected: ${active.map(([, , label]) => label).join(', ')}. Contact while the window is open.`
      : 'No active buying triggers detected.',
  };
}

const SENIORITY_VALUES: Record<string, number> = {
  owner: 1.0, c_level: 1.0, vp: 0.85, director: 0.75,
  manager: 0.55, engineer: 0.40, other: 0.25, unknown: 0.20,
};

const EMAIL_STATUS_VALUES: Record<string, number> = {
  valid: 1.0, catch_all: 0.55, unverified: 0.45, risky: 0.30, unknown: 0.30, invalid: 0.0,
};

const RELEVANT_DEPARTMENTS = ['facilities', 'operations', 'engineering', 'procurement', 'esg'];

export function factorContactQuality(input: ScoringInput, weight: number): FactorResult {
  const base = { key: 'contact_quality', label: 'Contact reachability & authority', weight };
  const c = input.contact;

  if (!c) {
    return {
      ...base, normalized: null, points: 0, confidence: 'absent',
      evidence: 'No contact identified yet — this lead cannot be emailed.',
    };
  }

  const deptBoost = RELEVANT_DEPARTMENTS.includes((c.department ?? '').toLowerCase()) ? 0.1 : 0;
  const normalized = clamp01(
    0.5 * (SENIORITY_VALUES[c.seniority] ?? 0.2) +
      0.5 * (EMAIL_STATUS_VALUES[c.emailStatus] ?? 0.3) +
      deptBoost,
  );

  return {
    ...base, normalized, points: weight * normalized,
    confidence: c.emailStatus === 'valid' ? 'high' : 'medium',
    evidence:
      `${c.seniority.replace('_', '-')}` +
      (c.department ? ` in ${c.department}` : '') +
      `, email status: ${c.emailStatus}.` +
      (c.emailStatus === 'invalid' ? ' Do not send — address will bounce.' : ''),
  };
}

export function factorServiceability(input: ScoringInput, weight: number): FactorResult {
  const base = { key: 'serviceability', label: 'Operational proximity', weight };
  const km = input.site?.distanceFromBaseKm;

  if (km == null) {
    return {
      ...base, normalized: null, points: 0, confidence: 'absent',
      evidence: 'Distance from operations base not computed.',
    };
  }

  // Full marks inside 100 km, tapering to zero at 600 km.
  const normalized = 1 - scale(km, 100, 600);
  return {
    ...base, normalized, points: weight * normalized, confidence: 'high',
    evidence:
      `${Math.round(km)} km from the nearest operations base` +
      (km <= 100 ? ' — within standard service radius.'
        : km <= 300 ? ' — serviceable, factor travel into margin.'
          : ' — long haul; O&M cost and response times will be a concern.'),
  };
}
