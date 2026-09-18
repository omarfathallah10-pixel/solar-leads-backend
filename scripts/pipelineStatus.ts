import 'dotenv/config';
import { PrismaClient } from '@prisma/client';

/**
 * Reports the count at every stage of the pipeline, so "nothing is showing up"
 * becomes a one-command answer instead of a guessing game.
 *
 *   npm run status
 *
 * Read it top to bottom: the first stage with a zero is where the problem is.
 */
async function main() {
  const prisma = new PrismaClient();

  const [companies, sites, measured, withIrradiance, contacts, leads, scored, sent] =
    await Promise.all([
      prisma.company.count(),
      prisma.companySite.count(),
      prisma.companySite.count({ where: { roofAreaM2: { not: null } } }),
      prisma.companySite.count({ where: { ghiKwhM2Day: { not: null } } }),
      prisma.contact.count({ where: { email: { not: null } } }),
      prisma.lead.count(),
      prisma.lead.count({ where: { currentScore: { not: null } } }),
      prisma.outreachMessage.count({ where: { sentAt: { not: null } } }),
    ]);

  const stages: [string, number, string][] = [
    ['Companies discovered', companies, 'Run a sweep from "Find new leads".'],
    ['Sites (buildings)', sites, 'Sweep found nothing — check OSM coverage for that area.'],
    ['Sites with a roof measurement', measured, 'Buildings had no polygon. Overpass may have returned centroids only.'],
    ['Sites with irradiance', withIrradiance, 'Enrichment has not run. Is the worker running? npm run dev:worker'],
    ['Contacts with an email', contacts, 'Website scraping found no addresses. Not blocking — leads still show as "needs a contact".'],
    ['LEADS (what the pipeline shows)', leads, 'Enrichment has not reached the lead-creation step yet.'],
    ['Leads with a score', scored, 'Scoring queue has not run.'],
    ['Intro emails sent', sent, 'Nothing approved yet.'],
  ];

  console.log('\nPipeline stages\n');
  let firstZero = true;
  for (const [label, count, hint] of stages) {
    const flag = count === 0 ? '  0 ' : String(count).padStart(5) + ' ';
    console.log(`${flag} ${label}`);
    if (count === 0 && firstZero) {
      console.log(`        → ${hint}`);
      firstZero = false;
    }
  }

  if (leads > 0) {
    const bands = await prisma.lead.groupBy({
      by: ['currentScoreBand'],
      _count: { _all: true },
    });
    console.log('\nScore bands');
    for (const b of bands) {
      console.log(`  ${String(b._count._all).padStart(5)} ${b.currentScoreBand ?? 'unscored'}`);
    }

    // The pipeline screen defaults to status=scored and score >= 60. Leads can
    // exist and still be invisible behind those filters, which looks identical
    // to having no leads at all.
    const visible = await prisma.lead.count({
      where: { status: 'scored', currentScore: { gte: 60 } },
    });
    console.log(
      `\n  ${visible} lead(s) match the pipeline's DEFAULT filters ` +
        `(status = scored, score >= 60).`,
    );
    if (visible === 0 && leads > 0) {
      console.log(
        '  → Leads exist but none pass the default filters. On the Pipeline\n' +
          '    screen, drag "Score at least" down to 0 and set status to "Any".',
      );
    }

    const top = await prisma.lead.findMany({
      where: { currentScore: { not: null } },
      orderBy: { currentScore: 'desc' },
      take: 5,
      include: { company: true, site: true },
    });
    if (top.length > 0) {
      console.log('\nTop leads\n');
      for (const lead of top) {
        const kwp = lead.site?.estimatedKwp ? `${Math.round(Number(lead.site.estimatedKwp))} kWp` : 'no size';
        const roof = lead.site?.roofAreaM2 ? `${Math.round(Number(lead.site.roofAreaM2))} m²` : 'no roof';
        console.log(
          `  ${String(lead.currentScore).padStart(5)}  ${lead.company.name.slice(0, 38).padEnd(40)} ${roof.padEnd(10)} ${kwp}`,
        );
      }
    }
  }

  console.log();
  await prisma.$disconnect();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
