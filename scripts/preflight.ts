import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import 'dotenv/config';

/**
 * Runs before any Prisma command in db:setup.
 *
 * Catches connection-string mistakes in half a second, with a fix, instead of
 * letting Prisma spend 30 seconds on a TCP timeout and report the generic
 * "P1001: Can't reach database server" — which says nothing about why.
 */

const problems: { what: string; why: string; fix: string }[] = [];

const dbUrl = process.env.DATABASE_URL ?? '';
const directUrl = process.env.DIRECT_URL ?? '';

if (!dbUrl) {
  problems.push({
    what: 'DATABASE_URL is not set',
    why: 'Nothing to connect to.',
    fix: 'Copy .env.example to .env and fill it in.',
  });
}

if (dbUrl && !directUrl) {
  problems.push({
    what: 'DIRECT_URL is not set',
    why: 'schema.prisma declares directUrl, and migrations use it.',
    fix: 'Self-hosted: set DIRECT_URL to the same value as DATABASE_URL.\n' +
      '       Supabase: set both to the session pooler string.',
  });
}

// The single most common Supabase failure, by a wide margin.
const DIRECT_HOST = /@db\.([a-z0-9]+)\.supabase\.co/;
for (const [name, url] of [['DATABASE_URL', dbUrl], ['DIRECT_URL', directUrl]] as const) {
  const match = DIRECT_HOST.exec(url);
  if (!match) continue;
  problems.push({
    what: `${name} uses the Supabase DIRECT host (db.${match[1]}.supabase.co)`,
    why:
      'Supabase serves that host over IPv6 only unless the project has the IPv4\n' +
      '       add-on. Most home and office networks are IPv4-only, so it is\n' +
      '       unreachable — this is what P1001 means here. The server is fine.',
    fix:
      'Supabase Dashboard → Connect → Session pooler. Use that string for BOTH\n' +
      `       DATABASE_URL and DIRECT_URL. It looks like:\n\n` +
      `       postgresql://postgres.${match[1]}:<password>@aws-0-<region>.pooler.supabase.com:5432/postgres\n\n` +
      '       Note the username is postgres.<project-ref>, not plain postgres.',
  });
}

// DIRECT_URL must never point at the TRANSACTION pooler. Prisma uses it for
// migrations, which need advisory locks and session state that PgBouncer
// discards between statements in transaction mode.
if (/pooler\.supabase\.com:6543/.test(directUrl)) {
  problems.push({
    what: 'DIRECT_URL points at the transaction pooler (port 6543)',
    why: 'Migrations need session-level features — advisory locks, temp state —\n' +
      '       that PgBouncer drops between statements in transaction mode.',
    fix: 'Change DIRECT_URL to the SESSION pooler: same host, port 5432, and\n' +
      '       remove ?pgbouncer=true from it. Keep DATABASE_URL on 6543 if you like.',
  });
}

// Unreplaced placeholders. Broad on purpose: [YOUR-PASSWORD] from the Supabase
// dashboard, <...> from documentation, and any <angle-bracket> text in any
// script — the point is to catch a value that was copied but never filled in.
const PLACEHOLDER = /\[[^\]]*(?:password|PASSWORD)[^\]]*\]|<[^>]{1,60}>/u;
for (const name of ['DATABASE_URL', 'DIRECT_URL', 'SESSION_SECRET', 'UNSUBSCRIBE_SECRET'] as const) {
  const value = process.env[name] ?? '';
  if (value && PLACEHOLDER.test(value)) {
    problems.push({
      what: `${name} still contains an unreplaced placeholder: ${PLACEHOLDER.exec(value)?.[0]}`,
      why: 'The value was copied from documentation but never filled in.',
      fix: name.endsWith('SECRET')
        ? 'Generate one with:\n' +
          '       node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'hex\'))"'
        : 'Put the real password in. URL-encode any of @ : / ? # & % first.',
    });
  }
}

// Duplicate keys in .env. dotenv keeps the LAST definition, so a leftover
// template line further down the file silently overrides a correct value
// further up — which looks like the file being ignored entirely.
const envPath = join(__dirname, '..', '.env');
if (existsSync(envPath)) {
  const seen = new Map<string, number[]>();
  readFileSync(envPath, 'utf8').split(/\r?\n/).forEach((line, i) => {
    const key = /^\s*([A-Z_][A-Z0-9_]*)\s*=/.exec(line)?.[1];
    if (!key) return;
    seen.set(key, [...(seen.get(key) ?? []), i + 1]);
  });
  for (const [key, lines] of seen) {
    if (lines.length > 1) {
      problems.push({
        what: `${key} is defined ${lines.length} times in .env (lines ${lines.join(', ')})`,
        why: 'dotenv keeps the LAST definition, so line ' + lines[lines.length - 1] +
          ' silently wins and\n       the earlier one is ignored.',
        fix: `Delete every ${key} line except the one you want.`,
      });
    }
  }
}

// UNSUBSCRIBE_SECRET signs opt-out links. A guessable one lets anyone forge an
// unsubscribe for any address, so a long-but-obvious string is not acceptable.
const LOW_ENTROPY = [/abcdefghij/i, /1234567890/, /secret-key/i, /^(.)\1+$/, /qwerty/i];
for (const name of ['SESSION_SECRET', 'UNSUBSCRIBE_SECRET'] as const) {
  const value = process.env[name] ?? '';
  if (value.length >= 32 && LOW_ENTROPY.some((re) => re.test(value))) {
    problems.push({
      what: `${name} is long but guessable`,
      why: name === 'UNSUBSCRIBE_SECRET'
        ? 'It signs opt-out links. A guessable key lets anyone forge an\n' +
          '       unsubscribe for any address in your pipeline.'
        : 'It signs sessions. A guessable key lets anyone forge a login.',
      fix: 'Generate a real one:\n' +
        '       node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'hex\'))"',
    });
  }
}

// Secrets the API needs at boot. Checked here so a missing one surfaces during
// setup rather than the first time someone runs dev:api.
for (const name of ['SESSION_SECRET', 'UNSUBSCRIBE_SECRET'] as const) {
  const value = process.env[name] ?? '';
  if (value.length < 32) {
    problems.push({
      what: value ? `${name} is shorter than 32 characters` : `${name} is not set`,
      why: 'The API refuses to boot without it. UNSUBSCRIBE_SECRET signs opt-out\n' +
        '       links — a weak one lets anyone forge an unsubscribe for any address.',
      fix: 'Generate one with:\n' +
        '       node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'hex\'))"',
    });
  }
}

// Transaction mode (6543) breaks interactive transactions unless told about it,
// and the lead-approval path depends on them.
if (/pooler\.supabase\.com:6543/.test(dbUrl) && !/pgbouncer=true/.test(dbUrl)) {
  problems.push({
    what: 'DATABASE_URL uses the transaction pooler (6543) without ?pgbouncer=true',
    why: 'Prisma will try to use prepared statements, which PgBouncer rejects in\n' +
      '       transaction mode.',
    fix: 'Either append ?pgbouncer=true&connection_limit=1, or switch to the\n' +
      '       session pooler on port 5432 — simpler, and this app has few clients.',
  });
}

if (/^postgres:[^.]/.test(dbUrl.split('@')[0]?.replace('postgresql://', '') ?? '') &&
    /pooler\.supabase\.com/.test(dbUrl)) {
  problems.push({
    what: 'Pooler username is missing the project-ref suffix',
    why: 'Supavisor routes by username. Plain `postgres` will fail authentication.',
    fix: 'Use postgres.<project-ref> as the username.',
  });
}

if (problems.length === 0) {
  const host = /@([^/:]+)/.exec(dbUrl)?.[1] ?? 'unknown host';
  console.log(`Preflight OK — connecting to ${host}\n`);
  process.exit(0);
}

console.error('\nStopped before running Prisma. Fix these in .env first:\n');
for (const p of problems) {
  console.error(`  ✗ ${p.what}`);
  console.error(`    why: ${p.why}`);
  console.error(`    fix: ${p.fix}\n`);
}
process.exit(1);
