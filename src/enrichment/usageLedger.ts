import { env } from '../config/env';
import { BudgetExceededError } from '../lib/errors';
import { logger } from '../lib/logger';
import { prisma } from '../lib/prisma';

/**
 * Estimated unit costs, USD per call. Verified September 2026 — re-check these
 * against each vendor's pricing page before relying on them for budgeting.
 * They exist to give an approximate running total and to trip the circuit
 * breaker, not to reconcile an invoice.
 */
export const UNIT_COSTS: Record<string, number> = {
  'google_solar:buildingInsights': 0.0,   // free up to 10k/month, then tiered
  'google_solar:buildingInsights:paid': 0.010,
  'google_places:textSearchPro': 0.032,   // $32.00 per 1,000 past the free cap
  'google_places:essentials': 0.0,        // 10k/month free
  'hunter:domainSearch': 0.0098,          // ~1 credit; Starter ≈ $49/5k credits
  'hunter:emailVerifier': 0.0049,
  'overpass:query': 0.0,                  // free, but rate-limited by courtesy
  'nasa_power:climatology': 0.0,          // free, no key
  'website:fetch': 0.0,
  // Gemini free tier: $0 per call, capped by requests-per-minute/day rather
  // than a dollar budget. Recorded here purely for call-volume visibility —
  // enrichCompanyContactWithGemini() does not call assertWithinBudget() at
  // all, so this never trips (or is gated by) the circuit breaker below.
  'gemini:gemini-1.5-flash': 0.0,
  'gemini:gemini-1.5-pro': 0.0,
};

interface RecordUsageArgs {
  provider: string;
  sku: string;
  units?: number;
  entityType?: string;
  entityId?: string;
}

export async function recordUsage(args: RecordUsageArgs): Promise<void> {
  const key = `${args.provider}:${args.sku}`;
  const unit = UNIT_COSTS[key] ?? 0;
  const units = args.units ?? 1;

  await prisma.apiUsage.create({
    data: {
      provider: args.provider,
      sku: args.sku,
      units,
      estCostUsd: unit * units,
      entityType: args.entityType ?? null,
      entityId: args.entityId ?? null,
    },
  });
}

export async function monthToDateSpendUsd(): Promise<number> {
  const start = new Date();
  start.setUTCDate(1);
  start.setUTCHours(0, 0, 0, 0);

  const agg = await prisma.apiUsage.aggregate({
    _sum: { estCostUsd: true },
    where: { occurredAt: { gte: start } },
  });
  return Number(agg._sum.estCostUsd ?? 0);
}

/**
 * The budget circuit breaker. Call before any paid external request.
 *
 * Without this, one buggy loop over 10,000 leads against a $32/1,000 SKU is a
 * $320 mistake made in four minutes, discovered on next month's invoice.
 */
export async function assertWithinBudget(): Promise<void> {
  const spent = await monthToDateSpendUsd();
  if (spent >= env.MONTHLY_API_BUDGET_USD) {
    logger.error({ spent, ceiling: env.MONTHLY_API_BUDGET_USD }, 'API budget exceeded');
    throw new BudgetExceededError(spent, env.MONTHLY_API_BUDGET_USD);
  }
  if (spent >= env.MONTHLY_API_BUDGET_USD * 0.8) {
    logger.warn({ spent, ceiling: env.MONTHLY_API_BUDGET_USD }, 'API budget above 80%');
  }
}

/** Idempotency helper: has this exact provider call already been made and cached? */
export async function getCachedRaw<T>(
  entityType: string,
  entityId: string,
  sourceKey: string,
  maxAgeDays?: number,
): Promise<T | null> {
  const row = await prisma.rawSourceRecord.findFirst({
    where: {
      entityType,
      entityId,
      sourceKey,
      ...(maxAgeDays
        ? { collectedAt: { gte: new Date(Date.now() - maxAgeDays * 86_400_000) } }
        : {}),
    },
    orderBy: { collectedAt: 'desc' },
  });
  return row ? (row.raw as T) : null;
}

/**
 * Persist a provider response verbatim. Two purposes: never pay twice for the
 * same lookup, and answer GDPR Art. 14 ("where did you get my data?") with a
 * single query instead of an archaeology project.
 */
export async function cacheRaw(args: {
  entityType: string;
  entityId: string;
  sourceKey: string;
  sourceUrl?: string;
  license?: string;
  raw: unknown;
}): Promise<void> {
  await prisma.rawSourceRecord.create({
    data: {
      entityType: args.entityType,
      entityId: args.entityId,
      sourceKey: args.sourceKey,
      sourceUrl: args.sourceUrl ?? null,
      license: args.license ?? null,
      raw: args.raw as object,
    },
  });
}
