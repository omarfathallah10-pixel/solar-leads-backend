import { GoogleGenerativeAI, SchemaType, type ResponseSchema } from '@google/generative-ai';
import * as cheerio from 'cheerio';
import { z } from 'zod';
import { env } from '../config/env';
import { logger } from '../lib/logger';
import { prisma } from '../lib/prisma';
import { cacheRaw, getCachedRaw, recordUsage } from './usageLedger';

/**
 * LLM-based contact extraction from a company's own website, via Gemini's
 * free tier.
 *
 * Used in place of a paid contact-database API (Apollo, etc.): the website is
 * free to fetch and Gemini's free tier costs nothing, so this whole path
 * carries no dollar cost and is NOT gated on the monthly budget breaker in
 * usageLedger.ts (see enrichCompanyContactWithGemini below). It is still a
 * FALLBACK, not a first resort — it only runs for companies the free
 * regex-based scraper (websiteScraper.ts) came up empty for, both to keep
 * traffic within Gemini's free-tier rate limits and because a name pulled
 * from regex matching a mailto: link is free and already reliable.
 */

const SYSTEM_PROMPT = `You extract B2B sales contact details from the text of a company website.

Find the single best point of contact for a cold sales outreach email: a named
person if one is given (an owner, manager, or named department contact — not
a generic "Sales Team"), their email address, and their phone number.

Rules:
- Only report information that is explicitly present in the text you are
  given. Never invent, guess, or infer a name, email, or phone number that
  does not literally appear.
- If no field is present, use null for that field. It is normal and expected
  for one or more fields to be null.
- Prefer a named individual over a department alias, but a generic address
  (e.g. info@, contact@) is an acceptable fallback for "email" when no
  better address is present.`;

const RESPONSE_SCHEMA: ResponseSchema = {
  type: SchemaType.OBJECT,
  properties: {
    contactName: { type: SchemaType.STRING, nullable: true },
    email: { type: SchemaType.STRING, nullable: true },
    phone: { type: SchemaType.STRING, nullable: true },
  },
  required: ['contactName', 'email', 'phone'],
};

export interface GeminiContactExtraction {
  contactName: string | null;
  email: string | null;
  phone: string | null;
}

const extractionSchema = z.object({
  contactName: z.string().trim().min(1).nullish(),
  email: z.string().trim().min(1).nullish(),
  phone: z.string().trim().min(1).nullish(),
});

/** Bounds the page text sent to the model: every extra character is tokens. */
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

function sanitizeExtraction(raw: unknown): GeminiContactExtraction | null {
  const parsed = extractionSchema.safeParse(raw);
  if (!parsed.success) {
    logger.warn({ issues: parsed.error.issues }, 'Gemini contact extraction: unexpected shape');
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

let client: GoogleGenerativeAI | null = null;
function getClient(): GoogleGenerativeAI | null {
  if (!env.GEMINI_API_KEY) return null;
  if (!client) client = new GoogleGenerativeAI(env.GEMINI_API_KEY);
  return client;
}

/**
 * Fetches a website and asks Gemini to pull out a name, email and phone
 * number from its visible text. Pure with respect to the database: callers
 * decide what to do with the result.
 *
 * Returns null on any failure (missing key, unreachable site, a blocked or
 * rate-limited response, malformed model output) — this is best-effort
 * enrichment and must never fail the enrichment job outright.
 */
export async function enrichContactWithGemini(
  websiteUrl: string,
  companyName: string,
): Promise<GeminiContactExtraction | null> {
  const genAI = getClient();
  if (!genAI) {
    logger.debug('GEMINI_API_KEY not set — skipping Gemini contact extraction');
    return null;
  }

  const url = websiteUrl.startsWith('http') ? websiteUrl : `https://${websiteUrl}`;
  const html = await fetchHtml(url);
  if (!html) {
    logger.debug({ url }, 'Gemini contact extraction: website unreachable');
    return null;
  }

  const pageText = extractReadableText(html);
  if (!pageText) return null;

  let content: string | null;
  try {
    const model = genAI.getGenerativeModel(
      {
        model: env.GEMINI_MODEL,
        systemInstruction: SYSTEM_PROMPT,
        generationConfig: {
          temperature: 0,
          responseMimeType: 'application/json',
          responseSchema: RESPONSE_SCHEMA,
        },
      },
      { timeout: 30_000 },
    );

    const result = await model.generateContent(
      `Company: ${companyName}\nWebsite: ${url}\n\nPage text:\n${pageText}`,
    );
    content = result.response.text();
  } catch (err) {
    logger.warn({ err, url }, 'Gemini contact extraction request failed');
    return null;
  } finally {
    // Recorded for visibility into call volume even though the free tier
    // costs nothing — see UNIT_COSTS in usageLedger.ts.
    await recordUsage({ provider: 'gemini', sku: env.GEMINI_MODEL });
  }

  if (!content) return null;

  let raw: unknown;
  try {
    raw = JSON.parse(content);
  } catch {
    logger.warn({ url, content: content.slice(0, 200) }, 'Gemini returned non-JSON content');
    return null;
  }

  return sanitizeExtraction(raw);
}

/**
 * DB-facing wrapper: runs the extraction for a company and, if it finds
 * anything useful, creates a Contact row for it.
 *
 * Deliberately skipped when the company already has a contact with an email —
 * this is a fallback, not something to re-run on every enrichment pass.
 * Not gated on assertWithinBudget(): Gemini's free tier has no dollar cost,
 * so it sits outside the paid-API circuit breaker entirely.
 */
export async function enrichCompanyContactWithGemini(companyId: string): Promise<void> {
  const company = await prisma.company.findUnique({ where: { id: companyId } });
  if (!company) return;

  const target = company.website ?? (company.domain ? `https://${company.domain}` : null);
  if (!target) return;

  const hasContact = await prisma.contact.findFirst({
    where: { companyId, email: { not: null } },
    select: { id: true },
  });
  if (hasContact) return;

  // Cache the raw extraction like every other provider response: avoids
  // hitting Gemini's free-tier rate limit twice for the same lookup, and
  // answers "where did this come from" with a single query.
  const cached = await getCachedRaw<GeminiContactExtraction>('company', companyId, 'gemini_contact', 30);
  const extraction = cached ?? (await enrichContactWithGemini(target, company.name));
  if (!extraction) return;

  if (!cached) {
    await cacheRaw({
      entityType: 'company', entityId: companyId, sourceKey: 'gemini_contact',
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
      emailSource: 'gemini_enrichment',
      phoneE164: extraction.phone,
      isPrimary: true,
    },
  });

  logger.info({ companyId }, 'contact created from Gemini website extraction');
}
