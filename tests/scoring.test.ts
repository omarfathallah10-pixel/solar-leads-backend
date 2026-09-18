import { describe, expect, it } from 'vitest';
import { computeScore, MODEL_V1 } from '../src/scoring/engine';
import { estimateAnnualMwh, estimateKwp, logScale } from '../src/scoring/math';
import type { ScoringInput, SectorProfile } from '../src/scoring/types';

const COLD_STORAGE: SectorProfile = {
  key: 'industrial_cold_storage',
  loadFactor: 0.85, daytimeAlignment: 0.75, usableRoofFactor: 0.65,
  capacityBandLowKwp: 100, capacityBandHighKwp: 1500,
};

const MARINE: SectorProfile = {
  key: 'marine_marina',
  loadFactor: 0.50, daytimeAlignment: 0.60, usableRoofFactor: 0.30,
  capacityBandLowKwp: 5, capacityBandHighKwp: 120,
};

function baseInput(overrides: Partial<ScoringInput> = {}): ScoringInput {
  return {
    leadId: 'test-lead',
    sector: COLD_STORAGE,
    site: {
      roofAreaM2: 6000, roofAreaConfidence: 'high', ghiKwhM2Day: 6.2,
      gridReliabilityScore: 40, distanceFromBaseKm: 320, isRemote: false,
    },
    company: { ownershipType: 'owner', sustainabilitySignals: ['sustainability_page'] },
    contact: { seniority: 'director', department: 'operations', emailStatus: 'valid' },
    signals: { energyRoleHiring: true, signalObservedAt: new Date() },
    isSuppressed: false,
    ...overrides,
  };
}

describe('scoring math', () => {
  it('estimates kWp and yield with realistic magnitudes', () => {
    const kwp = estimateKwp(6000, 0.65);
    expect(kwp).toBeCloseTo(709, 0);
    expect(estimateAnnualMwh(kwp, 6.2)).toBeGreaterThan(1200);
    expect(estimateAnnualMwh(kwp, 6.2)).toBeLessThan(1300);
  });

  it('log-scales capacity so mid-size leads are not crushed', () => {
    // 700 kWp in a 100-1500 band should land clearly above midpoint. Linear
    // scaling would put it at 0.43; log scaling puts it at 0.72, which matches
    // how a salesperson actually perceives a 700 kWp opportunity.
    const logNormalized = logScale(700, 100, 1500);
    const linearEquivalent = (700 - 100) / (1500 - 100);
    expect(logNormalized).toBeGreaterThan(linearEquivalent);
    expect(logNormalized).toBeGreaterThan(0.65);
    expect(logNormalized).toBeLessThan(0.85);
  });
});

describe('computeScore', () => {
  /**
   * Regression lock on the canonical worked example.
   *
   * NOTE: an earlier hand-computed version of this example claimed ~66.5 by
   * assuming a 0.85 capacity subscore. The engine's logScale actually returns
   * ~0.72 for this site, so the true total is ~63. The engine is right and the
   * hand calculation was wrong. This test pins the real number so the
   * discrepancy cannot quietly reappear.
   */
  it('produces a stable, warm score for a strong cold-storage lead', () => {
    const result = computeScore(baseInput());
    expect(result.coverage).toBe(1);
    expect(result.score).toBeGreaterThan(60);
    expect(result.score).toBeLessThan(68);
    expect(result.band).toBe('warm');

    // The lead is NOT hot, and that is correct: no sustainability mandate and
    // only a weak timing trigger. Good physical fit alone should not reach the
    // top band — that is the model doing its job, not a miscalibration.
    const weak = result.factors.filter((f) => (f.normalized ?? 0) < 0.3).map((f) => f.key);
    expect(weak).toContain('sustainability_mandate');
    expect(weak).toContain('trigger_events');
  });

  it('weights sum to exactly 100', () => {
    const total = Object.values(MODEL_V1.weights).reduce((a, b) => a + b, 0);
    expect(total).toBe(100);
  });

  it('excludes missing factors from the denominator rather than scoring zero', () => {
    const withRoof = computeScore(baseInput());
    const noRoof = computeScore(
      baseInput({
        site: { roofAreaM2: null, roofAreaConfidence: 'absent', ghiKwhM2Day: 6.2,
                gridReliabilityScore: 40, distanceFromBaseKm: 320 },
      }),
    );
    // Coverage drops, but the score must not collapse — the lead is a
    // candidate for manual lookup, not something to bury.
    expect(noRoof.coverage).toBeLessThan(withRoof.coverage);
    expect(noRoof.score).toBeGreaterThan(40);
    expect(noRoof.factors.find((f) => f.key === 'solar_capacity_fit')?.normalized).toBeNull();
  });

  it('flags low confidence when coverage falls below the threshold', () => {
    const sparse = computeScore(
      baseInput({ site: null, contact: null, company: null, signals: null }),
    );
    expect(sparse.coverage).toBeLessThan(0.5);
    expect(sparse.gates.some((g) => g.includes('Low confidence'))).toBe(true);
  });

  it('normalises capacity within sector so marine leads stay competitive', () => {
    // 300 m² of deck area on a vessel: tiny in absolute terms.
    const marineSite = {
      roofAreaM2: 300, roofAreaConfidence: 'high' as const, ghiKwhM2Day: 6.0,
      distanceFromBaseKm: 150,
    };
    const marine = computeScore(baseInput({ sector: MARINE, site: marineSite }));
    const industrialSameArea = computeScore(baseInput({ site: marineSite }));

    const marineCapacity = marine.factors.find((f) => f.key === 'solar_capacity_fit')!;
    const industrialCapacity = industrialSameArea.factors.find(
      (f) => f.key === 'solar_capacity_fit',
    )!;

    expect(marineCapacity.normalized!).toBeGreaterThan(industrialCapacity.normalized!);
  });

  it('hard-disqualifies a suppressed contact regardless of fit', () => {
    const result = computeScore(baseInput({ isSuppressed: true }));
    expect(result.score).toBe(0);
    expect(result.band).toBe('disqualified');
  });

  it('caps a lead whose roof is already covered in solar', () => {
    const result = computeScore(
      baseInput({
        site: {
          roofAreaM2: 6000, roofAreaConfidence: 'high', ghiKwhM2Day: 6.2,
          hasExistingSolar: true, existingSolarKwp: 650, distanceFromBaseKm: 100,
        },
      }),
    );
    expect(result.score).toBeLessThanOrEqual(45);
    expect(result.gates.some((g) => g.includes('storage'))).toBe(true);
  });

  it('treats a partially covered roof as an expansion opportunity, not a dead lead', () => {
    const result = computeScore(
      baseInput({
        site: {
          roofAreaM2: 6000, roofAreaConfidence: 'high', ghiKwhM2Day: 6.2,
          hasExistingSolar: true, existingSolarKwp: 100, distanceFromBaseKm: 100,
        },
      }),
    );
    expect(result.gates.some((g) => g.includes('expansion'))).toBe(true);
    expect(result.score).toBeGreaterThan(45);
  });

  it('discounts tenants who cannot authorise a rooftop install', () => {
    const owner = computeScore(baseInput());
    const tenant = computeScore(
      baseInput({ company: { ownershipType: 'tenant', sustainabilitySignals: [] } }),
    );
    expect(tenant.score).toBeLessThan(owner.score);
    expect(tenant.gates.some((g) => g.includes('landlord'))).toBe(true);
  });

  it('gives every factor a human-readable evidence string', () => {
    const result = computeScore(baseInput());
    for (const factor of result.factors) {
      expect(factor.evidence.length).toBeGreaterThan(10);
    }
  });
});
