import { env } from '../config/env';
import { fetchJson } from '../lib/http';
import { logger } from '../lib/logger';
import { assertWithinBudget, recordUsage } from './usageLedger';

/**
 * Hunter.io — contact discovery and email verification.
 *
 * Deliberately LAST in the enrichment waterfall and gated on lead score. The
 * free tier is roughly 50 credits/month across searches AND verifications
 * combined, which is a test harness, not a workflow. Every call here costs
 * money, so: never call it for a lead that has not already qualified on free
 * data, and always cache the response.
 */

interface HunterDomainSearchResponse {
  data?: {
    domain?: string;
    pattern?: string | null;
    organization?: string | null;
    emails?: Array<{
      value: string;
      type?: string;
      confidence?: number;
      first_name?: string | null;
      last_name?: string | null;
      position?: string | null;
      seniority?: string | null;
      department?: string | null;
      verification?: { status?: string };
    }>;
  };
  errors?: Array<{ id: string; code: number; details: string }>;
}

interface HunterVerifyResponse {
  data?: {
    status?: 'valid' | 'invalid' | 'accept_all' | 'webmail' | 'disposable' | 'unknown';
    result?: 'deliverable' | 'undeliverable' | 'risky' | 'unknown';
    score?: number;
  };
}

export interface HunterContact {
  email: string;
  firstName: string | null;
  lastName: string | null;
  title: string | null;
  seniority: string | null;
  department: string | null;
  confidence: number | null;
}

export interface DomainSearchResult {
  domain: string;
  /** e.g. "{first}.{last}" — lets us infer addresses without spending credits. */
  pattern: string | null;
  organization: string | null;
  contacts: HunterContact[];
  raw: unknown;
}

export async function domainSearch(
  domain: string,
  opts: { limit?: number; department?: string } = {},
): Promise<DomainSearchResult | null> {
  if (!env.HUNTER_API_KEY) {
    logger.debug('HUNTER_API_KEY not set — skipping Hunter domain search');
    return null;
  }
  await assertWithinBudget();

  const params = new URLSearchParams({
    domain,
    api_key: env.HUNTER_API_KEY,
    limit: String(opts.limit ?? 10),
  });
  if (opts.department) params.set('department', opts.department);

  const data = await fetchJson<HunterDomainSearchResponse>(
    `https://api.hunter.io/v2/domain-search?${params.toString()}`,
    { label: 'hunter:domainSearch', timeoutMs: 20_000, retries: 2 },
  );

  await recordUsage({ provider: 'hunter', sku: 'domainSearch' });

  if (!data.data) return null;

  return {
    domain: data.data.domain ?? domain,
    pattern: data.data.pattern ?? null,
    organization: data.data.organization ?? null,
    contacts: (data.data.emails ?? []).map((e) => ({
      email: e.value.toLowerCase(),
      firstName: e.first_name ?? null,
      lastName: e.last_name ?? null,
      title: e.position ?? null,
      seniority: e.seniority ?? null,
      department: e.department ?? null,
      confidence: e.confidence ?? null,
    })),
    raw: data,
  };
}

export type VerificationStatus =
  'valid' | 'invalid' | 'risky' | 'catch_all' | 'unknown';

export async function verifyEmail(email: string): Promise<VerificationStatus> {
  if (!env.HUNTER_API_KEY) return 'unknown';
  await assertWithinBudget();

  const data = await fetchJson<HunterVerifyResponse>(
    `https://api.hunter.io/v2/email-verifier?email=${encodeURIComponent(email)}` +
      `&api_key=${env.HUNTER_API_KEY}`,
    { label: 'hunter:emailVerifier', timeoutMs: 30_000, retries: 2 },
  );

  await recordUsage({ provider: 'hunter', sku: 'emailVerifier' });

  switch (data.data?.result) {
    case 'deliverable': return 'valid';
    case 'undeliverable': return 'invalid';
    case 'risky':
      return data.data.status === 'accept_all' ? 'catch_all' : 'risky';
    default: return 'unknown';
  }
}

/**
 * Zero-cost fallback: derive an address from the company's observed pattern.
 * Generating costs nothing; only verification spends a credit. For SMEs this
 * plus website scraping covers most of what Hunter would return anyway.
 */
export function inferEmailFromPattern(
  pattern: string | null,
  firstName: string | null,
  lastName: string | null,
  domain: string,
): string | null {
  if (!pattern || !firstName) return null;
  const f = firstName.toLowerCase().replace(/[^a-z]/g, '');
  const l = (lastName ?? '').toLowerCase().replace(/[^a-z]/g, '');
  if (!f) return null;

  const local = pattern
    .replace(/\{first\}/g, f)
    .replace(/\{last\}/g, l)
    .replace(/\{f\}/g, f.charAt(0))
    .replace(/\{l\}/g, l.charAt(0) || '');

  if (!local || /\{|\}/.test(local)) return null;
  return `${local}@${domain}`.toLowerCase();
}
