import { createHash } from 'node:crypto';

/**
 * Builds a BullMQ-safe custom job id.
 *
 * BullMQ composes its Redis keys as `bull:<queue>:<jobId>`, so a colon inside a
 * custom id is rejected outright with "Custom Ids cannot contain :". Every
 * separator here is a double underscore, and anything outside a conservative
 * character set is replaced — a jobId is an identity, not a display string, so
 * being over-strict costs nothing.
 *
 * Deterministic by design: the same inputs must always produce the same id,
 * because that is what makes a duplicate enqueue collapse instead of running
 * twice. That property is load-bearing for the intro-email guarantee.
 *
 * Deliberately free of imports beyond node:crypto, so it can be unit-tested
 * without validating env or opening a Redis connection.
 */
export function jobId(...parts: Array<string | number>): string {
  return parts
    .map((part) => String(part).replace(/[^A-Za-z0-9_.-]/g, '_'))
    .join('__');
}

/** Stable short digest, for keying a job on a structured payload. */
export function digest(value: unknown): string {
  return createHash('sha1').update(JSON.stringify(value)).digest('hex').slice(0, 12);
}
