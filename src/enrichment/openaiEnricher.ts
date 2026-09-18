import * as cheerio from 'cheerio';
import OpenAI from 'openai';
import { z } from 'zod';
import { env } from '../config/env';
import { logger } from '../lib/logger';
import { prisma } from '../lib/prisma';
import { assertWithinBudget, cacheRaw, getCachedRaw, recordUsage } from './usageLedger';

/**
 * LLM-based contact extraction from a company's own website.
 *
 * Used in place of a paid contact-database API (Apollo, etc.): the website is
 * free to fetch, and a small model can read a "Contact us" page about as well
 * as a human intern. It is deliberately a FALLBACK, not a first resort — it
 * only runs for companies the free regex-based scraper (websiteScraper.ts)
 * came up empty for, and it is gated on the same monthly budget breaker as
 * every other paid provider in this codebase.
 */

const SYSTEM_PROMPT = `You extract B2B sales contact details from the text of a company website.

Find the single best point of contact for a cold sales outreach email: a named
person if one is given (an owner, manager, or named department contact — not
a generic "Sales Team"), their email address, and their phone number.

Rules:
- Only report information that is explicitly present in the text below.
  Never invent, guess, or infer a name, email, or phone number that does not
  literally appear.
- If no field is present, use null for that field. It is normal and expected
  for one or more fields to be null.
- Prefer a named individual over a department alias, but a generic address
  (e.g. info@, contact@) is an acceptable fallback for "email" when no
  better address is present.

Respond with ONLY a JSON object of exactly this shape — no prose, no markdown
code fences, no extra keys:
{"contactName": string | null, "email": string | null, "phone": string | null}`;

export interface OpenAiContactExtraction {
  contactName: string | null;
  email: string | null;
  phone: string | null;
}

const extractionSchema = z.object({
  contactName: z.string().trim().min(1).nullish(),
  email: z.string().trim().min(1).nullish(),
  phone: z.string().trim().min(1).nullish(),
});

/** Bounds the page text sent to the model: every extra character is tokens, and tokens are money. */
const MAX_PAGE_TEXT_CHARS = 6_000;

async function fetchHtml(url: string, timeoutMs = 10_000): Promise<string | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': env.ENRICHMENT_USER_AGENT, Accept: 'text/html' },
      signal: controller.signal,
      redirect: 'follow',
    });
    if (!res.ok) return null;
    const contentType = res.headers.get('content-type') ?? '';
    if (!contentType.includes('text/html')) return null;
    // Guard against a 40 MB "HTML" file eating the worker's memory.
    const text = await res.text();
    return text.length > 2_000_000 ? text.slice(0, 2_000_000) : text;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** Strips tags, scripts and styles, leaving the readable text a human visitor would see. */
function extractReadableText(html: string): string {
  const $ = cheerio.load(html);
  $('script, style, noscript, svg').remove();
  const text = $('body').text().replace(/\s+/g, ' ').trim();
  return text.slice(0, MAX_PAGE_TEXT_CHARS);
}

function sanitizeExtraction(raw: unknown): OpenAiContactExtraction | null {
  const parsed = extractionSchema.safeParse(raw);
  if (!parsed.success) {
    logger.warn({ issues: parsed.error.issues }, 'OpenAI contact extraction: unexpected shape');
    return null;
  }

  const email = parsed.data.email && z.string().email().safeParse(parsed.data.email).success
    ? parsed.data.email.toLowerCase()
    : null;

  return {
    contactName: parsed.data.contactName ?? null,
    email,
    phone: parsed.data.phone ?? null,
  };
}

let client: OpenAI | null = null;
function getClient(): OpenAI | null {
  if (!env.OPENAI_API_KEY) return null;
  if (!client) client = new OpenAI({ apiKey: env.OPENAI_API_KEY, timeout: 30_000, maxRetries: 2 });
  return client;
}

/**
 * Fetches a website and asks the model to pull out a name, email and phone
 * number from its visible text. Pure with respect to the database: callers
 * decide what to do with the result.
 *
 * Returns null on any failure (missing key, unreachable site, budget
 * exceeded caller-side, malformed model output) — this is best-effort
 * enrichment and must never fail the enrichment job outright.
 */
export async function enrichContactWithOpenAI(
  websiteUrl: string,
  companyName: string,
): Promise<OpenAiContactExtraction | null> {
  const openai = getClient();
  if (!openai) {
    logger.debug('OPENAI_API_KEY not set — skipping OpenAI contact extraction');
    return null;
  }

  const url = websiteUrl.startsWith('http') ? websiteUrl : `https://${websiteUrl}`;
  const html = await fetchHtml(url);
  if (!html) {
    logger.debug({ url }, 'OpenAI contact extraction: website unreachable');
    return null;
  }

  const pageText = extractReadableText(html);
  if (!pageText) return null;

  await assertWithinBudget();

  let content: string | null;
  try {
    const completion = await openai.chat.completions.create({
      model: env.OPENAI_MODEL,
      temperature: 0,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        {
          role: 'user',
          content: `Company: ${companyName}\nWebsite: ${url}\n\nPage text:\n${pageText}`,
        },
      ],
    });
    content = completion.choices[0]?.message?.content ?? null;
  } catch (err) {
    logger.warn({ err, url }, 'OpenAI contact extraction request failed');
    return null;
  } finally {
    // Recorded whether or not the call ultimately succeeded — it was still
    // sent and billed by OpenAI once dispatched.
    await recordUsage({ provider: 'openai', sku: env.OPENAI_MODEL });
  }

  if (!content) return null;

  let raw: unknown;
  try {
    raw = JSON.parse(content);
  } catch {
    logger.warn({ url, content: content.slice(0, 200) }, 'OpenAI returned non-JSON content');
    return null;
  }

  return sanitizeExtraction(raw);
}

/**
 * DB-facing wrapper: runs the extraction for a company and, if it finds
 * anything useful, creates a Contact row for it.
 *
 * Deliberately skipped when the company already has a contact with an email —
 * this is a paid fallback, not something to re-run on every enrichment pass.
 */
export async function enrichCompanyContactWithOpenAI(companyId: string): Promise<void> {
  const company = await prisma.company.findUnique({ where: { id: companyId } });
  if (!company) return;

  const target = company.website ?? (company.domain ? `https://${company.domain}` : null);
  if (!target) return;

  const hasContact = await prisma.contact.findFirst({
    where: { companyId, email: { not: null } },
    select: { id: true },
  });
  if (hasContact) return;

  // Cache the raw extraction like every other provider response: never pay
  // OpenAI twice for the same lookup, and answer "where did this come from"
  // with a single query.
  const cached = await getCachedRaw<OpenAiContactExtraction>('company', companyId, 'openai_contact', 30);
  const extraction = cached ?? (await enrichContactWithOpenAI(target, company.name));
  if (!extraction) return;

  if (!cached) {
    await cacheRaw({
      entityType: 'company', entityId: companyId, sourceKey: 'openai_contact',
      sourceUrl: target, license: 'proprietary', raw: extraction,
    });
  }

  if (!extraction.email && !extraction.contactName && !extraction.phone) return;

  // The email might already belong to a contact on another company (a
  // shared agency inbox, a re-scrape after a merge) — the partial unique
  // index on email would reject a duplicate anyway, so check first.
  if (extraction.email) {
    const existing = await prisma.contact.findFirst({ where: { email: extraction.email } });
    if (existing) return;
  }

  const nameParts = extraction.contactName?.trim().split(/\s+/).filter(Boolean) ?? [];
  const [firstName, ...rest] = nameParts;

  await prisma.contact.create({
    data: {
      companyId,
      fullName: extraction.contactName,
      firstName: firstName ?? null,
      lastName: rest.length ? rest.join(' ') : null,
      email: extraction.email,
      emailStatus: 'unverified',
      emailSource: 'openai_enrichment',
      phoneE164: extraction.phone,
      isPrimary: true,
    },
  });

  logger.info({ companyId }, 'contact created from OpenAI website extraction');
}
