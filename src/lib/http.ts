import { env } from '../config/env';
import { PermanentError, TransientError } from './errors';
import { logger } from './logger';

export interface FetchJsonOptions extends Omit<RequestInit, 'signal'> {
  timeoutMs?: number;
  /** Number of retries for transient failures. Total attempts = retries + 1. */
  retries?: number;
  /** Label used in logs and the API usage ledger. */
  label: string;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * fetch() with a timeout, bounded retries with jittered exponential backoff,
 * and error classification. Every outbound call in the enrichment layer goes
 * through here so that retry behaviour is uniform and auditable.
 */
export async function fetchJson<T>(url: string, opts: FetchJsonOptions): Promise<T> {
  const { timeoutMs = 20_000, retries = 3, label, headers, ...rest } = opts;
  let lastErr: unknown;

  for (let attempt = 0; attempt <= retries; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const res = await fetch(url, {
        ...rest,
        headers: { 'User-Agent': env.ENRICHMENT_USER_AGENT, Accept: 'application/json', ...headers },
        signal: controller.signal,
      });

      if (res.ok) return (await res.json()) as T;

      const body = await res.text().catch(() => '');
      const snippet = body.slice(0, 500);

      // 4xx other than 429/408 will not fix themselves — stop immediately.
      if (res.status >= 400 && res.status < 500 && res.status !== 429 && res.status !== 408) {
        throw new PermanentError(`${label}: HTTP ${res.status} ${snippet}`, `HTTP_${res.status}`);
      }

      // Honour Retry-After when the provider tells us how long to wait.
      const retryAfter = Number(res.headers.get('retry-after'));
      throw new TransientError(
        `${label}: HTTP ${res.status} ${snippet}`,
        Number.isFinite(retryAfter) ? retryAfter * 1000 : undefined,
      );
    } catch (err) {
      lastErr = err;
      if (err instanceof PermanentError) throw err;
      if (attempt === retries) break;

      const base = err instanceof TransientError && err.retryAfterMs
        ? err.retryAfterMs
        : 500 * 2 ** attempt;
      const jitter = Math.random() * 250; // avoid thundering-herd on shared endpoints
      logger.warn({ label, attempt: attempt + 1, waitMs: base + jitter }, 'retrying request');
      await sleep(base + jitter);
    } finally {
      clearTimeout(timer);
    }
  }

  throw lastErr instanceof Error ? lastErr : new TransientError(`${label}: unknown failure`);
}

/** Simple token-bucket limiter for endpoints with a courtesy rate limit. */
export class RateLimiter {
  private queue: Promise<void> = Promise.resolve();
  constructor(private readonly minIntervalMs: number) {}

  /** Serialises calls and guarantees at least minIntervalMs between them. */
  schedule<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.queue.then(() => fn());
    // The chain must advance on failure too, otherwise one rejected call
    // deadlocks every subsequent request behind it. Swallow here only —
    // the caller still receives the rejection via `run`.
    this.queue = run.then(
      async () => { await sleep(this.minIntervalMs); },
      async () => { await sleep(this.minIntervalMs); },
    );
    return run;
  }
}
