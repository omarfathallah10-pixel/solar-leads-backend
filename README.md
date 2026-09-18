# Solar Leads — Backend

Lead generation and sales automation backend for a solar EPC. Node 20+,
TypeScript, Fastify, Prisma/PostgreSQL + PostGIS, BullMQ, Microsoft Graph.

---

## Quick start

```bash
cp .env.example .env          # fill in at minimum the secrets and DB/Redis URLs
npm install
docker compose up -d          # Postgres 16 + PostGIS, Valkey
npm run db:setup              # generate + migrate + constraints + seed, in order
npm run dev:api               # API on :3000
npm run dev:worker            # queue workers (separate terminal)
npm test                      # unit tests, no database needed
```

Verify: `npm run doctor`

## Using Supabase instead of local Postgres

Two things bite immediately.

**1. `P1001: Can't reach database server at db.<ref>.supabase.co:5432`**

That is the **direct** host. Supabase serves it over IPv6 only unless you have
bought the IPv4 add-on, and most office and home networks are IPv4-only — so it
is unreachable, not down. Use the **session pooler** host for both variables:

```
DATABASE_URL=postgresql://postgres.<ref>:<password>@aws-0-<region>.pooler.supabase.com:5432/postgres
DIRECT_URL=postgresql://postgres.<ref>:<password>@aws-0-<region>.pooler.supabase.com:5432/postgres
```

Copy them from Dashboard → Connect. The username is `postgres.<project-ref>`,
not plain `postgres`. Session mode (5432) is chosen over transaction mode (6543)
because the approval path uses interactive transactions and
`SELECT … FOR UPDATE`; session mode has no caveats around either. Move to 6543
with `?pgbouncer=true&connection_limit=1` only if you actually exhaust
connections.

**2. Never paste the URL into `schema.prisma`.** It contains the database
password and the file is committed to git. Prisma's "Hardcoding URLs in your
schema poses a security risk" warning means exactly that. If you already did,
rotate the password in Supabase — it is in your git history now.

Supabase does not provide Redis. BullMQ needs one: run it from
`docker compose up -d redis`, or point `REDIS_URL` at an Upstash free instance.

PostGIS is created by `npm run db:constraints`. If the role lacks rights, enable
it once from Dashboard → Database → Extensions and re-run.

---

## `ECONNREFUSED` while the API is clearly running

Almost always IPv4 vs IPv6, not a dead server.

On Windows, `localhost` resolves to `::1` first, and Node 18+ stopped
reordering DNS results to prefer IPv4. An API bound to `0.0.0.0` is IPv4-only,
so every client dialling `localhost:3000` reaches `::1`, finds nothing, and
reports `ECONNREFUSED` — indistinguishable from the server being down.

Two guards are in place: the API binds `::` (dual-stack) by default via `HOST`,
and the Vite proxy targets `http://127.0.0.1:3000` rather than `localhost` so
DNS is out of the path entirely.

Test with the IPv4 literal, never `localhost`:

```powershell
Invoke-RestMethod http://127.0.0.1:3000/health
```

If IPv6 is disabled on the machine, set `HOST=0.0.0.0` in `.env`.

---

## Something is broken

Run `npm run doctor` first. It checks, in the order things actually fail:
database reachable → PostGIS/citext/trgm extensions installed → tables exist →
duplicate-prevention indexes present → seed data loaded → lead count. Each
failure prints the command that fixes it.

An empty pipeline is not an error — it means no sweep has run yet.

---

## ⚠ Three things that will break the system if you get them wrong

**1. Never run `prisma db push`.**
It reconciles the database against `schema.prisma` alone and will silently drop
every index in `prisma/sql/constraints.sql` — including the two partial unique
indexes that make duplicate intro emails impossible. Use `npm run db:migrate` /
`npm run db:deploy`, which apply the constraints afterwards. If you ever do run
`db push`, follow it with `npm run db:constraints`.

**Why constraints.sql is not a Prisma migration:** Prisma applies migrations in
filename-timestamp order, so a hand-written file has to sort *after* the
generated init migration — which is impossible to guarantee, because the
generated one is stamped with whatever day the developer runs `migrate dev`.
Get it backwards and the constraints run against tables that do not exist yet,
the migration fails, and the database is left empty. Applying them as an
explicit post-step (`npm run db:constraints`, chained into `db:migrate` and
`db:deploy`, every statement `IF NOT EXISTS`) removes the ordering question.

**2. Valkey/Redis must run with `maxmemory-policy noeviction`.**
The default `allkeys-lru` evicts BullMQ job data under memory pressure. You lose
queued emails with no error anywhere. Already set in `docker-compose.yml`; check
it if you move to a managed Redis.

**3. Scope the Microsoft Graph app with an ApplicationAccessPolicy.**
`Mail.Send` as an *application* permission grants send-as rights over every
mailbox in the tenant. Restrict it before anyone from security asks:

```powershell
New-ApplicationAccessPolicy -AppId <client-id> `
  -PolicyScopeGroupId outreach-senders@yourcompany.com `
  -AccessRight RestrictAccess
```

---

## How duplicate prevention actually works

Three layers, only one of which is load-bearing.

| Layer | Mechanism | Catches |
|---|---|---|
| 1 | Deterministic BullMQ `jobId` = `intro:<leadId>` | Double-enqueue from retries or a redeploy |
| 2 | `SELECT … FOR UPDATE` on the lead row inside the approval transaction | Two reps clicking Approve at the same instant |
| **3** | **`uq_one_intro_per_contact` / `uq_one_intro_per_lead` partial unique indexes** | **Everything, including a backfill script nobody told you about** |

Layers 1 and 2 exist for good error messages and lower contention. **Layer 3 is
the guarantee.** A `23505` unique violation is caught in `approveLead.ts` and
returned as `ALREADY_CONTACTED` — an expected outcome, not an error.

Rows in `status = 'failed'` are excluded from the index so a genuinely failed
send can be retried. Rows in `'suppressed'` stay *inside* it so an opted-out
contact can never be re-attempted.

Prove it against a real database:

```bash
RUN_INTEGRATION=1 npx vitest run tests/duplicatePrevention.integration.test.ts
```

That test fires 20 concurrent approvals at one lead and asserts exactly one
message row exists afterwards.

---

## The enrichment pipeline

Five stages, each a BullMQ queue. The cost gate between stages 3 and 4 is the
entire budget strategy: **measure every building for free, buy contact data only
for the ones that already qualify.**

```
DISCOVER          RESOLVE           MEASURE            CONTACT          SCORE
Overpass/OSM  →   domain + web  →   roof area, kWp, →  named contact →  0-100
(free)            scrape (free)     irradiance         + email          + breakdown
                                    (free → 10k/mo)         ▲
                                    cheap ─────────────────►│ expensive
                                                            │
                                              gated on score ≥ 55
```

| Connector | Cost | Notes |
|---|---|---|
| `overpass.ts` | free | OSM polygons → roof area via `@turf/area`. ODbL; internal use is fine, redistribution has share-alike obligations. Rate-limited to 1 req / 3 s. |
| `websiteScraper.ts` | free | Emails + sustainability signals + timing triggers. Often better than paid data for SMEs. |
| `nasaPower.ts` | free | GHI climatology. Fetched once per site, cached forever — it is a climate normal. |
| `googleSolar.ts` | free to ~10k/mo | Real roof segments, tilt, azimuth, existing-array detection. Coverage is patchy outside US/EU; `NOT_FOUND` is an expected outcome and falls back to the OSM polygon. |
| `hunter.ts` | paid | Last resort. Free tier ≈ 50 credits/month total. Gated on score and on `assertWithinBudget()`. |

**Budget circuit breaker.** Every external call writes to `api_usage_ledger`.
`assertWithinBudget()` runs before each paid request and throws
`BudgetExceededError` past `MONTHLY_API_BUDGET_USD`, which the enrichment
processor converts into an `UnrecoverableError` so the queue stops rather than
hammering a closed gate. Check spend at `GET /api/analytics/api-spend`.

---

## Scoring

Pure functions in `src/scoring/`, zero I/O, fully unit-tested. That separation is
what makes weight tuning measurable: you can replay the engine over fixtures
without a database.

Key behaviours, each locked by a test:

- **Missing data leaves the denominator** rather than scoring zero. A lead
  scored on 6 of 8 factors reports `coverage: 0.82`, not a collapsed score.
  Scoring an unknown roof as zero would bury exactly the leads worth looking up.
- **Capacity normalises within sector.** A 30 kWp yacht is a strong marine lead
  and a hopeless industrial one. Without per-sector bands the marine sector is
  invisible in the pipeline.
- **Log scaling for capacity.** The gap between 50 and 500 kWp matters far more
  than between 4,550 and 5,000. Linear scaling crams mid-size leads into the
  bottom decile.
- **Gates apply after aggregation** so their effect is visible in the UI rather
  than buried inside a factor.

### Band cutoffs are guesses until you calibrate them

`hot 75 / warm 60 / cool 40` were set before a single lead existed. Once you have
~500 scored leads, run `suggestBandCutoffs()` in `src/scoring/calibrate.ts` — it
returns percentile-based cutoffs from your actual distribution. Symptom that you
need it: reps saying "everything is warm" or "nothing ever scores hot".

**Do not tune the weights until you have 150–200 leads with known outcomes.**
Before that, any adjustment is superstition. The process is in the architecture
document, §4.6.

---

## Email

**Cold intros go through Microsoft Graph from real rep mailboxes.** Not a bulk
ESP. It is literally the company domain, threading and replies work natively,
and it costs nothing on existing M365 seats.

Two Graph constraints worth knowing before designing around it:

- Graph only accepts custom headers prefixed `x-`, max 5. **`List-Unsubscribe`
  cannot be set.** Below ~5,000 sends/day the bulk-sender rules requiring it do
  not apply, so the opt-out is a plain-text line in the body. If you ever reach
  bulk volume, move that traffic to SES.
- `sendMail` returns no message id. We create a draft (which returns `id`,
  `internetMessageId` and `conversationId`), then send it. One extra round trip
  buys reliable reply matching — the metric that actually matters.

SES (`ses.ts`, SigV4 over `fetch`, no AWS SDK) handles system mail only.

**Deliverability rules that matter more than any of this code:** send from an
`outreach.` subdomain with its own DKIM so a reputation problem cannot take down
invoices on the root domain; warm up new mailboxes over 2–3 weeks; cap at 40–60
sends/day/mailbox and scale by *adding mailboxes*; plain text, no tracking pixel.

Open rate is deliberately not a headline metric — Apple MPP and corporate
scanners inflate it enough that 60% can mean nothing. Decisions go on replies.

---

## Operations

| Task | Cadence | Entry point |
|---|---|---|
| Reply detection | 5 min | `pollAllMailboxesForReplies()` |
| Reconciliation | 10 min | `reconcileOutreach()` |

Reconciliation re-enqueues messages stuck in `queued` for >5 min (safe: jobIds
are deterministic and the unique index still holds). Messages stuck in `sending`
for >30 min are **logged for a human, never auto-retried** — the worker died
mid-send and we cannot know whether the message went out. A second copy to a
cold prospect is worse than two minutes of manual checking.

Both run on `setInterval` in `worker.ts`. **If you scale to multiple worker
replicas, move them to BullMQ repeatable jobs** or they will run N times.

---

## What is not built yet

Honest list, so nobody discovers these in production:

- **Auth is a stub.** `server.ts` trusts an `x-user-id` header. Replace with
  session auth or Entra ID SSO before exposing beyond localhost. Left deliberately
  visible rather than half-implemented.
- **Follow-up sequences.** The schema and reply-cancellation logic support
  `followup_1` / `followup_2`; no scheduler creates them yet.
- **Template editing.** `GET /api/templates`, `GET /api/templates/:id/preview`
  and `PATCH /api/templates/:id` exist (list, render against a real lead,
  activate/deactivate). Editing wording must ship a NEW version rather than
  mutate a template that has already sent — that endpoint is not written.
- **Overture Maps importer.** OSM/Overpass is wired; the DuckDB path is not.
- **Outbound webhooks / CRM sync.** Tables exist, no dispatcher.
- **Email verification fallback.** Hunter only; no self-hosted Reacher.
- **Utility-scale scoring variant.** §4.4 of the architecture doc describes a
  separate model for EPC leads. Only the general model is implemented.

---

## Before writing more code: run the coverage spike

Two days, before anything else. Pull 200 buildings in your top three target
cities via `POST /api/discovery/run` and check them by eye against satellite
imagery. Everything here assumes OSM coverage is decent in your geography. In
some regions industrial buildings are mapped meticulously; in others they are
absent. **If coverage is poor, the pipeline shifts toward directory scraping and
manual sourcing, and the effort estimate roughly doubles.** Better to learn that
in week 2 than week 8.
