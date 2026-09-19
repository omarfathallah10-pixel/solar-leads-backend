import 'dotenv/config';
import { env } from '../src/config/env';
import { enrichCompanyContactWithGemini } from '../src/enrichment/geminiEnricher';
import { disconnectPrisma, prisma } from '../src/lib/prisma';

/**
 * Re-runs Gemini contact lookup for companies the pipeline already has a lead
 * for but never got a contact — the backlog left behind by switching
 * enrichment from website-scraping to Gemini's knowledge lookup (see
 * geminiEnricher.ts). Those companies were already processed once under the
 * old logic, which required a website URL that most Overpass leads never
 * had, so they were skipped and nothing will ever re-queue them on its own.
 *
 *   npm run enrich:retry
 *
 * Runs the lookup directly and synchronously (not via the BullMQ queue) so
 * progress prints to this terminal as it happens, company by company.
 */

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Keeps calls well under Gemini's free-tier requests-per-minute limit. A
// "quick utility script" run over a few hundred companies is exactly the
// kind of loop that trips a free tier if it fires as fast as Node can go.
const DELAY_MS = 4_000;

async function main() {
  if (!env.GEMINI_API_KEY) {
    console.error('GEMINI_API_KEY is not set — nothing for Gemini to do. Set it in .env first.');
    process.exitCode = 1;
    return;
  }

  // Mirrors the skip check inside enrichCompanyContactWithGemini itself: a
  // company counts as "done" once ANY contact has a valid email or a phone
  // number, not just when a Contact row exists at all.
  const candidates = await prisma.company.findMany({
    where: {
      leads: { some: {} },
      contacts: {
        none: {
          OR: [
            { email: { not: null }, emailStatus: { not: 'invalid' } },
            { phoneE164: { not: null } },
          ],
        },
      },
    },
    select: { id: true, name: true },
    orderBy: { createdAt: 'asc' },
  });

  console.log(`\nFound ${candidates.length} lead(s) with no usable contact.\n`);
  if (candidates.length === 0) {
    console.log('Nothing to retry.\n');
    await disconnectPrisma();
    return;
  }

  let found = 0;
  let stillEmpty = 0;

  for (let i = 0; i < candidates.length; i++) {
    const company = candidates[i];
    process.stdout.write(`[${i + 1}/${candidates.length}] ${company.name} ... `);

    try {
      await enrichCompanyContactWithGemini(company.id);
    } catch (err) {
      console.log('ERROR');
      console.error(err);
      continue;
    }

    // enrichCompanyContactWithGemini() is best-effort and returns void, so we
    // read back whatever it wrote (if anything) to report a real outcome
    // instead of just "done".
    const contact = await prisma.contact.findFirst({
      where: { companyId: company.id },
      orderBy: { createdAt: 'desc' },
      select: { fullName: true, email: true, phoneE164: true },
    });
    const company2 = await prisma.company.findUnique({
      where: { id: company.id },
      select: { website: true },
    });

    if (contact?.email || contact?.phoneE164) {
      found++;
      console.log(
        `found — ${contact.fullName ?? 'unnamed contact'} ` +
          `<${contact.email ?? 'no email'}> ${contact.phoneE164 ?? ''} ` +
          `${company2?.website ? `(${company2.website})` : ''}`.trim(),
      );
    } else {
      stillEmpty++;
      console.log('no match — Gemini did not recognise this company');
    }

    if (i < candidates.length - 1) await sleep(DELAY_MS);
  }

  console.log(`\nDone. ${found} enriched, ${stillEmpty} still without a contact, out of ${candidates.length}.\n`);
  await disconnectPrisma();
}

main().catch(async (err) => {
  console.error(err);
  await disconnectPrisma();
  process.exit(1);
});
