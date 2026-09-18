import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PrismaClient } from '@prisma/client';

/**
 * Applies prisma/sql/constraints.sql — the partial unique indexes, PostGIS
 * generated columns, and trigram indexes that Prisma's schema language cannot
 * express.
 *
 * Runs as an explicit step after `prisma migrate`, NOT as a migration, because
 * Prisma orders migrations by filename timestamp and a hand-written file cannot
 * reliably be timestamped after a generated one. Getting that backwards leaves
 * the database with no tables at all.
 *
 * Idempotent: every statement is IF NOT EXISTS.
 */
async function main() {
  const prisma = new PrismaClient();
  const path = join(__dirname, '..', 'prisma', 'sql', 'constraints.sql');
  const sql = readFileSync(path, 'utf8');

  const statements = sql
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('--'))
    .join('\n')
    .split(/;\s*(?:\n|$)/)
    .map((s) => s.trim())
    .filter(Boolean);

  console.log(`Applying ${statements.length} statements from constraints.sql`);

  // Supabase installs PostGIS into a dedicated `extensions` schema. Without it
  // on the search_path, ST_MakePoint and the geography type are not visible and
  // the generated-column statements fail with "type does not exist".
  // Harmless on self-hosted Postgres, where the schema simply will not exist.
  await prisma.$executeRawUnsafe(`SET search_path TO public, extensions`);

  let applied = 0;
  for (const statement of statements) {
    try {
      await prisma.$executeRawUnsafe(statement);
      applied++;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (/already exists/i.test(message)) continue;
      console.error(`\nFailed statement:\n${statement.slice(0, 300)}\n\n${message}\n`);
      await prisma.$disconnect();
      process.exit(1);
    }
  }

  // The whole point of this file. Verify rather than assume.
  const check = await prisma.$queryRawUnsafe<{ indexname: string }[]>(
    `SELECT indexname FROM pg_indexes WHERE indexname = 'uq_one_intro_per_contact'`,
  );

  if (check.length === 0) {
    console.error('\nuq_one_intro_per_contact is MISSING. Duplicate intro emails are possible.');
    await prisma.$disconnect();
    process.exit(1);
  }

  console.log(`${applied} statements applied. Duplicate-email guarantee is in place.`);
  await prisma.$disconnect();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
