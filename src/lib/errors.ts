/** Thrown when a caller asks for something that will never succeed on retry. */
export class PermanentError extends Error {
  readonly permanent = true;
  constructor(message: string, readonly code = 'PERMANENT') {
    super(message);
    this.name = 'PermanentError';
  }
}

/** Thrown for conditions that may resolve on their own: 429, 5xx, timeouts. */
export class TransientError extends Error {
  readonly permanent = false;
  constructor(message: string, readonly retryAfterMs?: number) {
    super(message);
    this.name = 'TransientError';
  }
}

export class BudgetExceededError extends PermanentError {
  constructor(spent: number, ceiling: number) {
    super(
      `Monthly API budget exceeded: $${spent.toFixed(2)} of $${ceiling.toFixed(2)}. ` +
        `Enrichment paused. Raise MONTHLY_API_BUDGET_USD or wait for the month to roll over.`,
      'BUDGET_EXCEEDED',
    );
  }
}

/**
 * Classifies an arbitrary thrown value into retry / don't-retry.
 * Anything unrecognised is treated as transient: a spurious retry is cheaper
 * than silently dropping a lead we already paid to enrich.
 */
export function isPermanent(err: unknown): boolean {
  if (err instanceof PermanentError) return true;
  if (err instanceof TransientError) return false;

  const status = (err as { status?: number; statusCode?: number })?.status ??
    (err as { statusCode?: number })?.statusCode;

  if (typeof status === 'number') {
    if (status === 429) return false;          // throttled — always retry
    if (status === 408) return false;          // request timeout
    return status >= 400 && status < 500;      // other 4xx won't fix themselves
  }
  return false;
}
