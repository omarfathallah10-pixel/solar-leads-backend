import { Prisma } from '@prisma/client';
import { prisma } from '../lib/prisma';

/**
 * Band cutoff calibration.
 *
 * The initial cutoffs (hot 75 / warm 60 / cool 40) are guesses. They were set
 * before a single lead existed, and whether a 58 is "good" depends entirely on
 * the distribution the scoring engine actually produces over YOUR data — which
 * in turn depends on the sector capacity bands, your geography's irradiance
 * spread, and how much enrichment coverage you achieve.
 *
 * Symptom that you need this: reps say "everything is warm" or "nothing ever
 * scores hot". That is a calibration problem, not a model problem.
 *
 * Run this once you have ~500 scored leads. It reports what the cutoffs WOULD
 * be at the given percentiles. It deliberately does not apply them: changing
 * band boundaries reshuffles everyone's pipeline, so a human approves it and it
 * ships as a new scoring model version.
 */
export interface BandCalibration {
  sampleSize: number;
  current: { hot: number; warm: number; cool: number };
  suggested: { hot: number; warm: number; cool: number };
  distribution: { p10: number; p25: number; p50: number; p75: number; p90: number };
  note: string;
}

export async function suggestBandCutoffs(
  current: { hot: number; warm: number; cool: number },
  targets = { hotPct: 0.85, warmPct: 0.60, coolPct: 0.30 },
): Promise<BandCalibration | null> {
  const rows = await prisma.$queryRaw<
    Array<{
      n: bigint; p10: number; p25: number; p50: number; p75: number; p90: number;
      hot_cut: number; warm_cut: number; cool_cut: number;
    }>
  >(Prisma.sql`
    SELECT COUNT(*)                                                        AS n,
           percentile_cont(0.10) WITHIN GROUP (ORDER BY current_score)     AS p10,
           percentile_cont(0.25) WITHIN GROUP (ORDER BY current_score)     AS p25,
           percentile_cont(0.50) WITHIN GROUP (ORDER BY current_score)     AS p50,
           percentile_cont(0.75) WITHIN GROUP (ORDER BY current_score)     AS p75,
           percentile_cont(0.90) WITHIN GROUP (ORDER BY current_score)     AS p90,
           percentile_cont(${targets.hotPct})  WITHIN GROUP (ORDER BY current_score) AS hot_cut,
           percentile_cont(${targets.warmPct}) WITHIN GROUP (ORDER BY current_score) AS warm_cut,
           percentile_cont(${targets.coolPct}) WITHIN GROUP (ORDER BY current_score) AS cool_cut
      FROM leads
     WHERE current_score IS NOT NULL
       -- Only leads with decent data coverage. Calibrating against half-enriched
       -- leads bakes your enrichment gaps into the band definitions.
       AND score_coverage >= 0.7
  `);

  const r = rows[0];
  if (!r || Number(r.n) < 100) return null; // too small a sample to mean anything

  const round = (n: number) => Math.round(n * 10) / 10;

  return {
    sampleSize: Number(r.n),
    current,
    suggested: { hot: round(r.hot_cut), warm: round(r.warm_cut), cool: round(r.cool_cut) },
    distribution: {
      p10: round(r.p10), p25: round(r.p25), p50: round(r.p50),
      p75: round(r.p75), p90: round(r.p90),
    },
    note:
      'Suggested cutoffs place the top 15% in "hot" and the top 40% in "warm". ' +
      'Review before applying — changing bands reshuffles every rep\'s pipeline, ' +
      'so ship it as a new scoring model version, not an in-place edit.',
  };
}
