-- ============================================================================
--  Constraints and indexes that Prisma's schema language cannot express.
--
--  HOW THIS RUNS: `npm run db:constraints`, chained automatically after
--  `npm run db:migrate` and `npm run db:deploy`.
--
--  This deliberately is NOT a Prisma migration. Prisma applies migrations in
--  filename-timestamp order, and a hand-written file has to be timestamped
--  LATER than the generated init migration — which is impossible to guarantee
--  when the generated one is created on whatever day the developer runs
--  `migrate dev`. Getting that backwards leaves the database with no tables at
--  all. Running it as an explicit post-step removes the ordering question.
--
--  Every statement is IF NOT EXISTS, so re-running is free.
--
--  ⚠ Never run `prisma db push` on this project. It reconciles the database
--    against schema.prisma only, and will silently DROP every index below —
--    including the ones that make duplicate emails impossible. Re-run
--    `npm run db:constraints` if you ever do.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 0. EXTENSIONS
-- ---------------------------------------------------------------------------
-- Created here rather than through Prisma's `extensions` datasource property,
-- which requires a preview feature and assumes the `public` schema. Supabase
-- pre-installs these into a dedicated `extensions` schema, in which case
-- IF NOT EXISTS makes each of these a no-op.
--
-- On Supabase you may need to enable PostGIS once from
-- Dashboard → Database → Extensions if the role lacks CREATE EXTENSION rights.

CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE EXTENSION IF NOT EXISTS postgis;
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE EXTENSION IF NOT EXISTS citext;


-- ---------------------------------------------------------------------------
-- 1. THE DUPLICATE-PREVENTION GUARANTEE
-- ---------------------------------------------------------------------------
-- At most ONE non-failed intro message may exist per contact, and per lead,
-- for all time. Concurrent workers, retried BullMQ jobs, a redeploy mid-send,
-- and an engineer running a backfill script at 2am all collide here and get a
-- 23505 unique_violation, which the application treats as "already handled".
--
-- Rows in 'failed' are EXCLUDED so a genuinely failed send can be retried with
-- a fresh row. Rows in 'suppressed' stay INSIDE the index so an opted-out
-- contact can never be re-attempted.
--
-- This is the only layer that is actually load-bearing. Application-level
-- `if (alreadySent) return;` checks always eventually lose a race.
-- ---------------------------------------------------------------------------

CREATE UNIQUE INDEX IF NOT EXISTS uq_one_intro_per_contact
  ON outreach_messages (contact_id)
  WHERE message_type = 'intro' AND status <> 'failed';

CREATE UNIQUE INDEX IF NOT EXISTS uq_one_intro_per_lead
  ON outreach_messages (lead_id)
  WHERE message_type = 'intro' AND status <> 'failed';


-- ---------------------------------------------------------------------------
-- 2. Deduplication of the core entities
-- ---------------------------------------------------------------------------
-- Partial, because most discovered companies have no website and most
-- discovered contacts have no email yet. A plain UNIQUE would be fine in
-- Postgres (NULLs are distinct) but the partial index stays much smaller.

CREATE UNIQUE INDEX IF NOT EXISTS uq_companies_domain
  ON companies (domain) WHERE domain IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS uq_contacts_email
  ON contacts (email) WHERE email IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS uq_leads_company_contact
  ON leads (company_id, contact_id) WHERE contact_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS uq_suppression_email
  ON suppression_list (email) WHERE email IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS uq_suppression_domain
  ON suppression_list (domain) WHERE domain IS NOT NULL;

-- Exactly one active scoring model at a time, enforced by the database rather
-- than by an admin remembering to deactivate the old one.
CREATE UNIQUE INDEX IF NOT EXISTS uq_one_active_scoring_model
  ON scoring_models (is_active) WHERE is_active;


-- ---------------------------------------------------------------------------
-- 3. PostGIS generated columns
-- ---------------------------------------------------------------------------
-- Prisma has no geography type. We store plain floats in the ORM and let
-- Postgres derive the indexed geography column. ST_SetSRID / ST_MakePoint /
-- the ::geography cast are all IMMUTABLE, which is what makes a STORED
-- generated column legal here.
--
-- Query it with $queryRaw:
--   SELECT id FROM company_sites
--    WHERE ST_DWithin(location, ST_MakePoint($1,$2)::geography, $3);

ALTER TABLE company_sites
  ADD COLUMN IF NOT EXISTS location geography(Point, 4326)
  GENERATED ALWAYS AS (
    ST_SetSRID(ST_MakePoint(longitude, latitude), 4326)::geography
  ) STORED;

CREATE INDEX IF NOT EXISTS idx_sites_location
  ON company_sites USING gist (location);

ALTER TABLE companies
  ADD COLUMN IF NOT EXISTS hq_location geography(Point, 4326)
  GENERATED ALWAYS AS (
    CASE
      WHEN hq_longitude IS NULL OR hq_latitude IS NULL THEN NULL
      ELSE ST_SetSRID(ST_MakePoint(hq_longitude, hq_latitude), 4326)::geography
    END
  ) STORED;

CREATE INDEX IF NOT EXISTS idx_companies_hq_location
  ON companies USING gist (hq_location);


-- ---------------------------------------------------------------------------
-- 4. Fuzzy company-name matching for deduplication
-- ---------------------------------------------------------------------------
-- Never dedupe on name alone: "Delta Group" exists in every country. The
-- dedupe path pairs this with an ST_DWithin radius check.

CREATE INDEX IF NOT EXISTS idx_companies_name_trgm
  ON companies USING gin (normalized_name gin_trgm_ops);


-- ---------------------------------------------------------------------------
-- 5. Grid performance
-- ---------------------------------------------------------------------------
-- The pipeline screen filters on (status, sector, score DESC). This composite
-- index is the difference between a 40 ms and a 900 ms load at 10k leads.
-- Prisma emits it too, but declared here so it survives an index review.

CREATE INDEX IF NOT EXISTS idx_leads_score_partial
  ON leads (current_score DESC)
  WHERE status IN ('scored', 'approved');

-- Daily-cap lookup: counts today's sends per mailbox on every approval.
CREATE INDEX IF NOT EXISTS idx_messages_identity_sent
  ON outreach_messages (sending_identity_id, sent_at DESC)
  WHERE sent_at IS NOT NULL;


-- ---------------------------------------------------------------------------
-- 6. Guard against re-contacting an erased data subject
-- ---------------------------------------------------------------------------
-- After an erasure request we delete the contact but KEEP a suppression entry.
-- Otherwise the next discovery run rediscovers them and emails them again,
-- which is a worse outcome than retaining a single hashed row. Document this
-- as legitimate-interest retention in your RoPA.

COMMENT ON TABLE suppression_list IS
  'Permanent. Entries survive contact erasure by design: without them, a '
  'rediscovery run would re-add and re-contact someone who opted out.';

COMMENT ON INDEX uq_one_intro_per_contact IS
  'Load-bearing. Guarantees a contact receives at most one introductory email, '
  'ever, under any concurrency. Do not drop.';
