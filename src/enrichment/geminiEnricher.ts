import { GoogleGenerativeAI, SchemaType, type ResponseSchema } from '@google/generative-ai';
import { Prisma } from '@prisma/client';
import { z } from 'zod';
import { env } from '../config/env';
import { logger } from '../lib/logger';
import { prisma } from '../lib/prisma';
import { cacheRaw, getCachedRaw, recordUsage } from './usageLedger';

/**
 * LLM-knowledge-based contact lookup, via Gemini's free tier.
 *
 * Most leads discovered from Overpass/OSM have no website at all — they are a
 * footprint polygon and a name tag, nothing more — so the old approach
 * (scrape the company's own site, then ask an LLM to read it) never had
 * anything to run on for the majority of the pipeline. This version skips
 * scraping entirely and asks Gemini directly, from its own training
 * knowledge, whether it recognises the named company and can supply its
 * website / email / phone / a contact person.
 *
 * This trades a hard dependency (must already have a URL) for a softer,
 * riskier one (the model might recognise the company, or might guess). A
 * guess that is wrong is worse than no answer at all — a fabricated email
 * gets sent a cold outreach message, dents inbox reputation, and pollutes
 * the database with a real-looking row that isn't real. Everything below
 * exists to make that failure mode rare and, when it slips through, cheap to
 * spot: strict output schema, plausibility filters on every field, a live
 * reachability check on any claimed website, and a distinct `emailSource` of
 * 'gemini_knowledge' (as opposed to 'website_scrape' or 'gemini_enrichment')
 * so this lower-confidence tier stays visible and auditable downstream.
 *
 * Free-tier and NOT gated on assertWithinBudget() — see usageLedger.ts.
 * Still a FALLBACK: only runs for companies with no usable contact yet.
 */

const SYSTEM_PROMPT = `You are a B2B sales research assistant. You are given a company's name and,
when known, its location or business sector. From your own training
knowledge — you cannot browse the web — identify, for that SPECIFIC company:
the official website, a direct contact email address, a phone number, and
the name of a key contact person (an owner, manager, or named department
head — not a generic "Sales Team" or "Customer Support").

This is knowledge recall, not a search engine, and getting it wrong has a
real cost: a fabricated answer will be used to send this company an actual
email. So:
- Only answer for a company you are highly confident you specifically
  recognise, matching both the name AND the given location/sector. A small
  or local business (a single petrol station, a regional workshop, an
  independent hotel) that you do not specifically recognise is almost
  certainly NOT something you actually know — say so with nulls rather than
  substituting a similarly-named chain, franchise, or unrelated company.
- Never invent, guess, estimate, or fabricate a website, email, phone
  number, or person's name. If you are not highly confident a field is
  correct for THIS exact company, return null for that field. Returning
  null is the CORRECT and EXPECTED answer for most small or local
  businesses — it is not a failure.
- If you do not specifically recognise the company at all, return all four
  fields as null.`;

const RESPONSE_SCHEMA: ResponseSchema = {
  type: SchemaType.OBJECT,
  properties: {
    website: { type: SchemaType.STRING, nullable: true },
    contactName: { type: SchemaType.STRING, nullable: true },
    email: { type: SchemaType.STRING, nullable: true },
    phone: { type: SchemaType.STRING, nullable: true },
  },
  required: ['website', 'contactName', 'email', 'phone'],
};

export interface GeminiLookupResult {
  website: string | null;
  contactName: string | null;
  email: string | null;
  phone: string | null;
}

const rawResponseSchema = z.object({
  website: z.string().trim().min(1).nullish(),
  contactName: z.string().trim().min(1).nullish(),
  email: z.string().trim().min(1).nullish(),
  phone: z.string().trim().min(1).nullish(),
});

/**
 * Phrases the model sometimes emits in place of an actual null when it wants
 * to hedge ("the contact is generally the Sales Team") despite instructions.
 * Caught here rather than trusted as real data.
 */
const PLACEHOLDER_NAMES = new Set([
  'unknown', 'n/a', 'na', 'not available', 'not found', 'none', 'unavailable',
  'sales team', 'sales department', 'customer service', 'customer support',
  'support team', 'contact us', 'info', 'general inquiries', 'front desk',
]);

function isPlausibleUrl(value: string): string | null {
  const withScheme = value.startsWith('http') ? value : `https://${value}`;
  try {
    const url = new URL(withScheme);
    return url.hostname.includes('.') ? withScheme : null;
  } catch {
    return null;
  }
}

function sanitizeExtraction(raw: unknown): GeminiLookupResult | null {
  const parsed = rawResponseSchema.safeParse(raw);
  if (!parsed.success) {
    logger.warn({ issues: parsed.error.issues }, 'Gemini contact lookup: unexpected shape');
    return null;
  }

  const contactName = parsed.data.contactName && !PLACEHOLDER_NAMES.has(parsed.data.contactName.toLowerCase())
    ? parsed.data.contactName
    : null;

  const email = parsed.data.email && z.string().email().safeParse(parsed.data.email).success
    ? parsed.data.email.toLowerCase()
    : null;

  // Requiring several digits filters out non-answers like "see our website"
  // slipping through as a "phone number".
  const phone = parsed.data.phone && (parsed.data.phone.match(/\d/g)?.length ?? 0) >= 6
    ? parsed.data.phone
    : null;

  const website = parsed.data.website ? isPlausibleUrl(parsed.data.website) : null;

  return { website, contactName, email, phone };
}

/** A live GET, not just a URL-shape check: Gemini cannot browse, so a claimed
 *  website is a guess until something actually answers at that address. */
async function isWebsiteReachable(url: string, timeoutMs = 8_000): Promise<boolean> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': env.ENRICHMENT_USER_AGENT, Accept: 'text/html' },
      signal: controller.signal,
      redirect: 'follow',
    });
    return res.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

function buildLocationHint(parts: {
  hqCity?: string | null;
  hqCountryCode?: string | null;
  siteCity?: string | null;
  siteCountryCode?: string | null;
  siteAddress?: string | null;
  sectorName?: string | null;
}): string | null {
  const city = parts.hqCity ?? parts.siteCity;
  const country = parts.hqCountryCode ?? parts.siteCountryCode;
  const cityCountry = [city, country].filter(Boolean).join(', ');
  if (cityCountry) return cityCountry;
  if (parts.siteAddress) return parts.siteAddress;
  if (parts.sectorName) return `${parts.sectorName} sector (exact location unknown)`;
  return null;
}

let client: GoogleGenerativeAI | null = null;
function getClient(): GoogleGenerativeAI | null {
  if (!env.GEMINI_API_KEY) return null;
  if (!client) client = new GoogleGenerativeAI(env.GEMINI_API_KEY);
  return client;
}

/**
 * Asks Gemini, from its own knowledge, to identify a named company's
 * website, email, phone and a contact person. Pure with respect to the
 * database: callers decide what to do with the result.
 *
 * Returns null on any failure (missing key, blocked/rate-limited response,
 * malformed model output) — this is best-effort enrichment and must never
 * fail the enrichment job outright.
 */
export async function lookupContactWithGemini(
  companyName: string,
  location: string | null,
): Promise<GeminiLookupResult | null> {
  const genAI = getClient();
  if (!genAI) {
    logger.debug('GEMINI_API_KEY not set — skipping Gemini contact lookup');
    return null;
  }

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
      `Company name: "${companyName}"\n` +
        `Location: ${location ?? 'unknown'}\n\n` +
        'Identify this specific company\'s official website, a direct contact ' +
        'email, a phone number, and a key contact person, only if you ' +
        'specifically recognise this company from your training knowledge.',
    );
    content = result.response.text();
  } catch (err) {
    logger.warn({ err, companyName }, 'Gemini contact lookup request failed');
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
    logger.warn({ companyName, content: content.slice(0, 200) }, 'Gemini returned non-JSON content');
    return null;
  }

  return sanitizeExtraction(raw);
}

/**
 * DB-facing wrapper: looks up a company via Gemini's internal knowledge and,
 * if it finds anything useful, writes it onto the company's contact record.
 *
 * Deliberately skipped when the company already has a contact with a valid
 * email OR a phone number — this is a last-resort fallback, not something to
 * re-run once ANY usable channel exists.
 */
export async function enrichCompanyContactWithGemini(companyId: string): Promise<void> {
  const company = await prisma.company.findUnique({
    where: { id: companyId },
    include: { sector: true },
  });
  if (!company) return;

  const hasContact = await prisma.contact.findFirst({
    where: {
      companyId,
      OR: [
        { email: { not: null }, emailStatus: { not: 'invalid' } },
        { phoneE164: { not: null } },
      ],
    },
    select: { id: true },
  });
  if (hasContact) return;

  const site = await prisma.companySite.findFirst({
    where: { companyId },
    select: { city: true, countryCode: true, address: true },
  });

  const location = buildLocationHint({
    hqCity: company.hqCity,
    hqCountryCode: company.hqCountryCode,
    siteCity: site?.city,
    siteCountryCode: site?.countryCode,
    siteAddress: site?.address,
    sectorName: company.sector?.name,
  });

  // Cache the raw lookup like every other provider response: avoids hitting
  // Gemini's free-tier rate limit twice for the same company, and answers
  // "where did this come from" with a single query.
  const cached = await getCachedRaw<GeminiLookupResult>('company', companyId, 'gemini_lookup', 30);
  const extraction = cached ?? (await lookupContactWithGemini(company.name, location));
  if (!extraction) return;

  if (!cached) {
    await cacheRaw({
      entityType: 'company', entityId: companyId, sourceKey: 'gemini_lookup',
      license: 'proprietary', raw: extraction,
    });
  }

  if (!extraction.email && !extraction.contactName && !extraction.phone && !extraction.website) {
    return;
  }

  // The email might already belong to a contact on another company. Treat a
  // collision as a sign this was a mismatched/hallucinated identification
  // rather than risk attaching one person's address to two companies.
  if (extraction.email) {
    const existingElsewhere = await prisma.contact.findFirst({ where: { email: extraction.email } });
    if (existingElsewhere) {
      logger.warn({ companyId, email: extraction.email }, 'Gemini-claimed email belongs to another company, discarding');
      return;
    }
  }

  // Gemini cannot browse, so a claimed website is unverified until something
  // actually answers there. Only worth checking if the company does not
  // already have one on record.
  let website: string | null = null;
  if (extraction.website && !company.website) {
    website = (await isWebsiteReachable(extraction.website)) ? extraction.website : null;
    if (!website) {
      logger.debug({ companyId, claimed: extraction.website }, 'Gemini-claimed website unreachable, discarding');
    }
  }

  if (website) {
    await prisma.company.update({ where: { id: companyId }, data: { website } });
  }

  if (!extraction.email && !extraction.phone && !extraction.contactName) return;

  // hasContact (above) already established that no contact on this company
  // has a usable email or phone — so any existing row is missing both, and
  // gets filled in rather than duplicated.
  const existingContact = await prisma.contact.findFirst({
    where: { companyId },
    orderBy: { createdAt: 'asc' },
  });

  const nameParts = extraction.contactName?.trim().split(/\s+/).filter(Boolean) ?? [];
  const [firstName, ...rest] = nameParts;
  const lastName = rest.length ? rest.join(' ') : null;

  if (existingContact) {
    const data: Prisma.ContactUpdateInput = {};
    if (!existingContact.fullName && extraction.contactName) data.fullName = extraction.contactName;
    if (!existingContact.firstName && firstName) data.firstName = firstName;
    if (!existingContact.lastName && lastName) data.lastName = lastName;
    if (!existingContact.email && extraction.email) {
      data.email = extraction.email;
      data.emailSource = 'gemini_knowledge';
    }
    if (!existingContact.phoneE164 && extraction.phone) data.phoneE164 = extraction.phone;

    if (Object.keys(data).length > 0) {
      await prisma.contact.update({ where: { id: existingContact.id }, data });
      logger.info({ companyId }, 'existing contact filled in from Gemini knowledge lookup');
    }
    return;
  }

  await prisma.contact.create({
    data: {
      companyId,
      fullName: extraction.contactName,
      firstName: firstName ?? null,
      lastName,
      email: extraction.email,
      emailStatus: 'unverified',
      emailSource: extraction.email ? 'gemini_knowledge' : null,
      phoneE164: extraction.phone,
      isPrimary: true,
    },
  });

  logger.info({ companyId }, 'contact created from Gemini knowledge lookup');
}
