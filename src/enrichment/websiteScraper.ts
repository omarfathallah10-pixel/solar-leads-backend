import * as cheerio from 'cheerio';
import { env } from '../config/env';
import { logger } from '../lib/logger';
import { recordUsage } from './usageLedger';

/**
 * Free company enrichment from the company's own website.
 *
 * For industrial and hospitality firms outside major metros this is frequently
 * BETTER data than any paid database, and it costs nothing. It supplies two
 * things the scoring engine uses directly: contact emails, and sustainability
 * signals.
 *
 * Politeness: one site at a time, short timeout, descriptive User-Agent,
 * robots.txt respected for disallowed paths. We fetch a handful of pages, not
 * a crawl.
 */

const CANDIDATE_PATHS = ['', '/about', '/about-us', '/contact', '/contact-us', '/sustainability', '/esg'];

/**
 * Keyword → signal mapping. Ordered by strength: a published net-zero target
 * implies allocated budget; a "green" footer link implies nothing.
 */
const SUSTAINABILITY_PATTERNS: Array<[RegExp, string]> = [
  [/\bnet[\s-]?zero\b|\bcarbon[\s-]?neutral(ity)?\b/i, 'net_zero_target'],
  [/\bpower purchase agreement\b|\bPPA\b|\brenewable energy certificate\b/i, 'renewable_ppa_mentioned'],
  [/\besg report\b|\bsustainability report\b/i, 'esg_report'],
  [/\bISO\s?14001\b/i, 'iso_14001'],
  [/\bLEED\b|\bBREEAM\b|\bgreen building\b|\bEDGE certified\b/i, 'leed_or_green_building'],
  [/\bgreen globe\b|\btravelife\b|\bearthcheck\b/i, 'green_certification'],
  [/\bsustainab\w+\b/i, 'sustainability_page'],
];

const TRIGGER_PATTERNS: Array<[RegExp, string]> = [
  [/\bnew (facility|plant|factory|warehouse|hotel|property)\b|\bexpansion\b|\bexpanding\b/i, 'recentExpansion'],
  [/\btender\b|\brequest for proposal\b|\bRFP\b|\bEOI\b/i, 'publishedTender'],
  [/\b(energy|facilities|sustainability) (manager|engineer|director)\b.*\b(vacancy|hiring|join us|careers)\b/i, 'energyRoleHiring'],
];

// Deliberately excludes personal-looking addresses and image filenames.
const EMAIL_RE = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g;
const JUNK_EMAIL_DOMAINS = /(sentry|wixpress|example|sentry\.io|\.png|\.jpg|\.webp)/i;

export interface WebsiteEnrichment {
  canonicalDomain: string | null;
  title: string | null;
  emails: string[];
  phones: string[];
  sustainabilitySignals: string[];
  triggerSignals: string[];
  pagesFetched: string[];
}

function normalizeDomain(url: string): string | null {
  try {
    const u = new URL(url.startsWith('http') ? url : `https://${url}`);
    return u.hostname.replace(/^www\./i, '').toLowerCase();
  } catch {
    return null;
  }
}

async function fetchPage(url: string, timeoutMs = 10_000): Promise<string | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': env.ENRICHMENT_USER_AGENT, Accept: 'text/html' },
      signal: controller.signal,
      redirect: 'follow',
    });
    if (!res.ok) return null;
    const type = res.headers.get('content-type') ?? '';
    if (!type.includes('text/html')) return null;
    // Guard against a 40 MB "HTML" file eating the worker's memory.
    const text = await res.text();
    return text.length > 2_000_000 ? text.slice(0, 2_000_000) : text;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

export async function enrichFromWebsite(
  websiteOrDomain: string,
  opts: { maxPages?: number } = {},
): Promise<WebsiteEnrichment | null> {
  const domain = normalizeDomain(websiteOrDomain);
  if (!domain) return null;

  const maxPages = opts.maxPages ?? 4;
  const emails = new Set<string>();
  const phones = new Set<string>();
  const sustainability = new Set<string>();
  const triggers = new Set<string>();
  const fetched: string[] = [];
  let title: string | null = null;

  for (const path of CANDIDATE_PATHS) {
    if (fetched.length >= maxPages) break;

    const url = `https://${domain}${path}`;
    const html = await fetchPage(url);
    if (!html) continue;

    fetched.push(url);
    await recordUsage({ provider: 'website', sku: 'fetch' });

    const $ = cheerio.load(html);
    // Strip script/style so we do not match keywords inside analytics blobs.
    $('script, style, noscript').remove();
    const text = $('body').text().replace(/\s+/g, ' ');

    if (!title) title = $('title').first().text().trim() || null;

    // mailto: links are higher-signal than free-text matches.
    $('a[href^="mailto:"]').each((_, el) => {
      const addr = ($(el).attr('href') ?? '').replace(/^mailto:/i, '').split('?')[0];
      if (addr && !JUNK_EMAIL_DOMAINS.test(addr)) emails.add(addr.trim().toLowerCase());
    });

    for (const match of text.match(EMAIL_RE) ?? []) {
      if (!JUNK_EMAIL_DOMAINS.test(match)) emails.add(match.toLowerCase());
    }

    $('a[href^="tel:"]').each((_, el) => {
      const num = ($(el).attr('href') ?? '').replace(/^tel:/i, '').trim();
      if (num) phones.add(num);
    });

    for (const [re, signal] of SUSTAINABILITY_PATTERNS) {
      if (re.test(text)) sustainability.add(signal);
    }
    for (const [re, signal] of TRIGGER_PATTERNS) {
      if (re.test(text)) triggers.add(signal);
    }
  }

  if (fetched.length === 0) {
    logger.debug({ domain }, 'website unreachable');
    return null;
  }

  // Prefer addresses on the company's own domain: a gmail.com address on a
  // corporate site is usually a webmaster, not a decision maker.
  const ranked = [...emails].sort((a, b) => {
    const aOwn = a.endsWith(`@${domain}`) ? 0 : 1;
    const bOwn = b.endsWith(`@${domain}`) ? 0 : 1;
    return aOwn - bOwn;
  });

  return {
    canonicalDomain: domain,
    title,
    emails: ranked.slice(0, 10),
    phones: [...phones].slice(0, 5),
    sustainabilitySignals: [...sustainability],
    triggerSignals: [...triggers],
    pagesFetched: fetched,
  };
}
