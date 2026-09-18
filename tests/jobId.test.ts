import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * BullMQ composes its Redis keys as `bull:<queue>:<jobId>`, so a custom job id
 * containing a colon is rejected with "Custom Ids cannot contain :".
 *
 * Every single jobId in this codebase originally used colons, which meant no
 * queue worked at all — including the intro-email idempotency key that is
 * supposed to guarantee one email per contact. These tests exist so that
 * failure cannot silently return.
 */

import { digest, jobId } from '../src/queues/jobId';

describe('jobId', () => {
  it('never emits a colon, even when an input contains one', () => {
    expect(jobId('intro', 'a:b:c')).not.toContain(':');
    expect(jobId('score', 'id', Date.now())).not.toContain(':');
  });

  it('strips every character outside the safe set', () => {
    const out = jobId('discover', '{"south":29.8,"west":31}');
    expect(out).toMatch(/^[A-Za-z0-9_.-]+$/);
  });

  it('is deterministic — duplicate enqueues must collapse, not run twice', () => {
    const lead = '7c9e1a02-4b3d-4f11-9a77-2b8c5d0e6f31';
    expect(jobId('intro', lead)).toBe(jobId('intro', lead));

    const bbox = { south: 30.24, west: 31.65, north: 30.36, east: 31.85 };
    expect(digest(bbox)).toBe(digest({ ...bbox }));
  });

  it('keeps distinct inputs distinct', () => {
    expect(jobId('intro', 'a')).not.toBe(jobId('intro', 'b'));
    expect(jobId('intro', 'a')).not.toBe(jobId('followup_1', 'a'));
  });
});

describe('source scan', () => {
  /** Walks src/ so a future colon in a template-literal jobId fails CI. */
  function sourceFiles(dir: string): string[] {
    return readdirSync(dir).flatMap((entry) => {
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) return sourceFiles(full);
      return full.endsWith('.ts') ? [full] : [];
    });
  }

  it('has no jobId built from a colon-separated template literal', () => {
    const offenders: string[] = [];
    for (const file of sourceFiles(join(__dirname, '..', 'src'))) {
      readFileSync(file, 'utf8').split('\n').forEach((line, i) => {
        // Matches  jobId: `...:...`  which is the exact shape of the bug.
        if (/jobId:\s*`[^`]*:/.test(line)) offenders.push(`${file}:${i + 1}`);
      });
    }
    expect(offenders).toEqual([]);
  });
});
