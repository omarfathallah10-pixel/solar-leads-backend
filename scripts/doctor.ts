import 'dotenv/config';
import { PrismaClient } from '@prisma/client';

/**
 * Diagnoses the usual causes of a 500 from the API, in the order they actually
 * happen. Run this before reading any stack trace.
 *
 *   npm run doctor
 */
const REQUIRED_TABLES = [
  'sectors', 'companies', 'company_sites', 'contacts', 'leads',
  'scoring_models', 'lead_scores', 'outreach_messages', 'email_templates',
  'sending_identities', 'suppression_list', 'consent_records',
];

const REQUIRED_INDEXES = [
  'uq_one_intro_per_contact', 'uq_one_intro_per_lead',
  'uq_companies_domain', 'uq_contacts_email', 'idx_sites_location',
];

const check = (ok: boolean, label: string, fix?: string) => {
  console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${label}`);
  if (!ok && fix) console.log(`        → ${fix}`);
  return ok;
};

async function main() {
  console.log('\nChecking the database\n');
  const prisma = new PrismaClient();
  let healthy = true;

  try {
    await prisma.$queryRaw`SELECT 1`;
    check(true, 'database reachable');
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    check(false, 'database reachable');

    if (/P1001|Can't reach database server/i.test(message)) {
      const host = /at `([^`]+)`/.exec(message)?.[1] ?? '';
      if (/^db\..*\.supabase\.co/.test(host)) {
        console.log(`
        → This is the Supabase DIRECT host. Supabase serves it over IPv6 only
          unless you have bought the IPv4 add-on, and most office and home
          networks are IPv4-only — so it is unreachable, not down.

          Dashboard → Connect → copy the SESSION POOLER string, and use it for
          BOTH DATABASE_URL and DIRECT_URL:

          postgresql://postgres.<ref>:<password>@aws-0-<region>.pooler.supabase.com:5432/postgres

          Note the username is postgres.<project-ref>, not plain postgres.`);
      } else {
        console.log('        → Is Postgres running? docker compose up -d');
      }
    } else if (/password authentication failed/i.test(message)) {
      console.log('        → Wrong password, or the username is missing the .<project-ref> suffix.');
    } else {
      console.log('        → Is Postgres running? docker compose up -d');
    }

    console.log(`\n${message}\n`);
    process.exit(1);
  }

  const exts = await prisma.$queryRaw<{ extname: string }[]>`
    SELECT extname FROM pg_extension`;
  const names = exts.map((e) => e.extname);
  for (const ext of ['postgis', 'pg_trgm', 'citext', 'pgcrypto']) {
    healthy = check(
      names.includes(ext),
      `extension ${ext}`,
      `Run: npm run db:constraints. On Supabase, enable it from ` +
        `Dashboard → Database → Extensions if that fails.`,
    ) && healthy;
  }

  const tables = await prisma.$queryRaw<{ tablename: string }[]>`
    SELECT tablename FROM pg_tables WHERE schemaname = 'public'`;
  const tableNames = tables.map((t) => t.tablename);
  const missingTables = REQUIRED_TABLES.filter((t) => !tableNames.includes(t));
  healthy = check(
    missingTables.length === 0,
    `tables exist (${tableNames.length} found)`,
    `Missing: ${missingTables.join(', ')}. Run: npm run db:setup`,
  ) && healthy;

  if (missingTables.length === 0) {
    const indexes = await prisma.$queryRaw<{ indexname: string }[]>`
      SELECT indexname FROM pg_indexes WHERE schemaname = 'public'`;
    const indexNames = indexes.map((i) => i.indexname);
    const missingIndexes = REQUIRED_INDEXES.filter((i) => !indexNames.includes(i));
    healthy = check(
      missingIndexes.length === 0,
      'duplicate-prevention indexes present',
      `Missing: ${missingIndexes.join(', ')}. Run: npm run db:constraints`,
    ) && healthy;

    // Tables present but constraints absent is the exact signature of
    // `prisma db push`, which builds the schema and skips constraints.sql.
    if (missingIndexes.length > 0) {
      console.log(`
        This looks like the database was built with 'prisma db push'.
        It creates tables from schema.prisma and skips prisma/sql/constraints.sql
        entirely, so right now:
          - a contact CAN receive the same introductory email twice
          - PostGIS location columns do not exist, so company deduplication
            fails and lead sourcing will error
        Fix: npm run db:constraints`);
    }

    const [sectors, models, templates] = await Promise.all([
      prisma.sector.count(),
      prisma.scoringModel.count({ where: { isActive: true } }),
      prisma.emailTemplate.count({ where: { isActive: true } }),
    ]);
    healthy = check(sectors > 0, `sectors seeded (${sectors})`, 'Run: npm run db:seed') && healthy;
    healthy = check(models === 1, `exactly one active scoring model (${models})`, 'Run: npm run db:seed') && healthy;
    healthy = check(templates > 0, `active email template (${templates})`, 'Run: npm run db:seed') && healthy;

    const leads = await prisma.lead.count();
    check(true, `leads in pipeline: ${leads}`);
    if (leads === 0) {
      console.log('        → Empty pipeline is not an error. Run a sweep from "Find new leads".');
    }
  }

  await prisma.$disconnect();
  console.log(healthy ? '\nAll checks passed.\n' : '\nFix the FAIL lines above, then re-run.\n');
  process.exit(healthy ? 0 : 1);
}

main().catch((err) => {
  console.error('\nDoctor itself crashed — that usually means the Prisma client was never generated.');
  console.error('Run: npx prisma generate\n');
  console.error(err);
  process.exit(1);
});
