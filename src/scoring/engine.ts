import { createHash } from 'node:crypto';
import {
  factorContactQuality, factorGridPain, factorIrradiance, factorSectorEnergyProfile,
  factorServiceability, factorSolarCapacity, factorSustainability, factorTriggerEvents,
} from './factors';
import { estimateKwp } from './math';
import type { Band, FactorResult, ScoreResult, ScoringInput, ScoringModelConfig } from './types';

export const MODEL_V1: ScoringModelConfig = {
  version: 'v1-2026-09',
  weights: {
    solar_capacity_fit: 22,
    sector_energy_profile: 18,
    grid_pain: 14,
    trigger_events: 12,
    sustainability_mandate: 10,
    contact_quality: 10,
    irradiance: 8,
    serviceability: 6,
  },
  bands: { hot: 75, warm: 60, cool: 40 },
  minCoverageForConfidence: 0.5,
};

/**
 * Deterministic hash of every input that affects the score. A batch re-score
 * compares this against the stored value and skips leads whose inputs have not
 * changed — the difference between a 30-second and a 20-minute re-score run
 * at 10k leads.
 */
export function hashScoringInputs(input: ScoringInput, modelVersion: string): string {
  const stable = {
    m: modelVersion,
    s: input.sector,
    site: input.site ?? null,
    co: input.company ?? null,
    ct: input.contact ?? null,
    sg: input.signals
      ? { ...input.signals, signalObservedAt: input.signals.signalObservedAt?.toISOString() ?? null }
      : null,
    sup: input.isSuppressed,
  };
  return createHash('sha256').update(JSON.stringify(stable)).digest('hex').slice(0, 32);
}

export function computeScore(input: ScoringInput, model: ScoringModelConfig = MODEL_V1): ScoreResult {
  const w = model.weights;
  const gates: string[] = [];

  const factors: FactorResult[] = [
    factorSolarCapacity(input, w.solar_capacity_fit ?? 0),
    factorSectorEnergyProfile(input, w.sector_energy_profile ?? 0),
    factorGridPain(input, w.grid_pain ?? 0),
    factorTriggerEvents(input, w.trigger_events ?? 0),
    factorSustainability(input, w.sustainability_mandate ?? 0),
    factorContactQuality(input, w.contact_quality ?? 0),
    factorIrradiance(input, w.irradiance ?? 0),
    factorServiceability(input, w.serviceability ?? 0),
  ];

  // ---- Coverage-aware aggregation -----------------------------------------
  // Factors with no data are removed from BOTH numerator and denominator. A
  // lead scored on 6 of 8 factors is scored on those 6 and flagged at 0.82
  // coverage — it is NOT punished for data we failed to fetch. Scoring a
  // missing roof area as zero would bury exactly the leads a salesperson
  // should go look up manually.
  const scored = factors.filter((f) => f.normalized !== null);
  const availableWeight = scored.reduce((s, f) => s + f.weight, 0);
  const totalWeight = factors.reduce((s, f) => s + f.weight, 0);
  const earnedPoints = scored.reduce((s, f) => s + f.points, 0);

  let score = availableWeight > 0 ? (earnedPoints / availableWeight) * 100 : 0;
  const coverage = totalWeight > 0 ? availableWeight / totalWeight : 0;

  // ---- Hard gates ----------------------------------------------------------
  // Applied AFTER aggregation so their effect is visible and explainable
  // instead of being buried inside a factor.

  if (input.isSuppressed) {
    gates.push('Contact has opted out or complained — permanently disqualified.');
    return {
      leadId: input.leadId, score: 0, band: 'disqualified',
      coverage, factors, gates, modelVersion: model.version,
    };
  }

  if (input.contact?.emailStatus === 'invalid') {
    gates.push('Email address verified as invalid — not contactable until re-enriched.');
    score = Math.min(score, 35);
  }

  if (input.site?.hasExistingSolar) {
    const existing = input.site.existingSolarKwp ?? 0;
    const potential = input.site.roofAreaM2
      ? estimateKwp(input.site.roofAreaM2, input.sector.usableRoofFactor)
      : 0;

    // A partially covered roof is an EXPANSION lead, often easier to close than
    // a greenfield one. A fully covered roof is a storage / O&M lead instead.
    if (potential > 0 && existing / potential < 0.5) {
      gates.push(
        `Existing ${Math.round(existing)} kWp array covers <50% of usable roof — ` +
          `treat as an expansion opportunity.`,
      );
    } else {
      gates.push(
        'Roof already substantially covered by solar — reposition as storage / O&M / repowering.',
      );
      score = Math.min(score, 45);
    }
  }

  if (input.company?.ownershipType === 'tenant') {
    gates.push('Company appears to be a tenant, not the asset owner — landlord consent required.');
    score *= 0.7;
  }

  score = Math.round(Math.max(0, Math.min(100, score)) * 10) / 10;

  const band: Band =
    score >= model.bands.hot ? 'hot'
      : score >= model.bands.warm ? 'warm'
        : score >= model.bands.cool ? 'cool'
          : 'cold';

  if (coverage < model.minCoverageForConfidence) {
    gates.push(
      `Low confidence: only ${Math.round(coverage * 100)}% of scoring weight is backed by ` +
        `real data. Enrich before acting on this score.`,
    );
  }

  return {
    leadId: input.leadId,
    score,
    band,
    coverage: Math.round(coverage * 1000) / 1000,
    factors,
    gates,
    modelVersion: model.version,
  };
}
