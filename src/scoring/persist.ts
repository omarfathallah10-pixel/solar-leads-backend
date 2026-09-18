import { prisma } from '../lib/prisma';
import { logger } from '../lib/logger';
import { computeScore, hashScoringInputs, MODEL_V1 } from './engine';
import { loadScoringInput } from './loadInput';
import type { ScoreResult, ScoringModelConfig } from './types';

/**
 * Scores one lead and persists the result.
 *
 * Writes a LeadScore row (immutable history) and denormalises score + band onto
 * the lead for fast grid filtering. Skips the write entirely when the inputs
 * hash is unchanged, which is what makes a full re-score of 10k leads cheap.
 */
export async function scoreAndPersist(
  leadId: string,
  opts: { force?: boolean } = {},
): Promise<ScoreResult | null> {
  const input = await loadScoringInput(leadId);
  if (!input) {
    logger.warn({ leadId }, 'cannot score: lead missing, or has no sector assigned');
    return null;
  }

  const activeModel = await prisma.scoringModel.findFirst({ where: { isActive: true } });
  const config: ScoringModelConfig = activeModel
    ? (activeModel.config as unknown as ScoringModelConfig)
    : MODEL_V1;

  const inputsHash = hashScoringInputs(input, config.version);

  if (!opts.force) {
    const latest = await prisma.leadScore.findFirst({
      where: { leadId },
      orderBy: { computedAt: 'desc' },
      select: { inputsHash: true },
    });
    if (latest?.inputsHash === inputsHash) return null; // nothing changed
  }

  const result = computeScore(input, config);

  await prisma.$transaction(async (tx) => {
    const row = await tx.leadScore.create({
      data: {
        leadId,
        modelId: activeModel?.id ?? (await ensureBootstrapModel(tx, config)),
        score: result.score,
        band: result.band,
        coverage: result.coverage,
        breakdown: { factors: result.factors, gates: result.gates } as object,
        inputsHash,
      },
    });

    await tx.lead.update({
      where: { id: leadId },
      data: {
        currentScore: result.score,
        currentScoreBand: result.band,
        currentScoreId: row.id,
        scoreCoverage: result.coverage,
        lastScoredAt: new Date(),
      },
    });

    // Advance ONLY 'new'/'enriching' leads to 'scored'. A separate updateMany
    // with a status guard, rather than a field on the update above, so that a
    // re-score can never regress a lead that is already approved or contacted.
    await tx.lead.updateMany({
      where: { id: leadId, status: { in: ['new', 'enriching'] } },
      data: { status: 'scored' },
    });
  });

  return result;
}

/** First run only: persists MODEL_V1 so LeadScore rows always have a model FK. */
async function ensureBootstrapModel(
  tx: Parameters<Parameters<typeof prisma.$transaction>[0]>[0],
  config: ScoringModelConfig,
): Promise<string> {
  const existing = await tx.scoringModel.findUnique({ where: { version: config.version } });
  if (existing) return existing.id;

  const created = await tx.scoringModel.create({
    data: {
      version: config.version,
      name: 'Bootstrap model',
      isActive: true,
      config: config as unknown as object,
      notes: 'Auto-created on first score. Replace via the admin model editor.',
    },
  });
  return created.id;
}
