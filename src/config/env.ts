import 'dotenv/config';
import { z } from 'zod';

/**
 * Fail fast on misconfiguration. A worker that boots with an empty
 * MS_GRAPH_CLIENT_SECRET and only discovers it on the first send has already
 * marked messages as 'sending' and burned a retry budget.
 */
const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().default(3000),
  /**
   * '::' binds dual-stack, so both 127.0.0.1 and ::1 reach the API.
   *
   * This matters on Windows: `localhost` resolves to ::1 first, and Node 18+
   * stopped reordering DNS results to prefer IPv4. Binding 0.0.0.0 (IPv4 only)
   * therefore makes every `localhost:3000` client report ECONNREFUSED while the
   * server is running perfectly — which is indistinguishable from the server
   * being down.
   *
   * Override to 0.0.0.0 if the host has IPv6 disabled entirely.
   */
  HOST: z.string().default('::'),
  APP_URL: z.string().url(),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),

  DATABASE_URL: z.string().min(1),
  // Prisma reads DIRECT_URL itself for migrations; validated here so a missing
  // value fails at boot rather than halfway through a deploy.
  DIRECT_URL: z.string().min(1),
  REDIS_URL: z.string().min(1),

  SESSION_SECRET: z.string().min(32),
  UNSUBSCRIBE_SECRET: z.string().min(32),

  OPS_BASE_LAT: z.coerce.number().min(-90).max(90),
  OPS_BASE_LON: z.coerce.number().min(-180).max(180),

  // Optional at boot so the API can start without outreach configured.
  // Validated again, hard, inside the Graph provider before the first send.
  MS_GRAPH_TENANT_ID: z.string().optional(),
  MS_GRAPH_CLIENT_ID: z.string().optional(),
  MS_GRAPH_CLIENT_SECRET: z.string().optional(),

  AWS_REGION: z.string().default('eu-west-1'),
  SES_CONFIGURATION_SET: z.string().optional(),
  SENDING_DOMAIN: z.string().default('example.com'),

  OVERPASS_ENDPOINT: z.string().url().default('https://overpass-api.de/api/interpreter'),
  NASA_POWER_ENDPOINT: z
    .string()
    .url()
    .default('https://power.larc.nasa.gov/api/temporal/climatology/point'),
  GOOGLE_MAPS_API_KEY: z.string().optional(),
  HUNTER_API_KEY: z.string().optional(),

  MONTHLY_API_BUDGET_USD: z.coerce.number().default(50),
  ENRICHMENT_USER_AGENT: z.string().default('SolarLeads/0.1'),

  DEFAULT_MAILBOX_DAILY_CAP: z.coerce.number().default(50),
  MIN_SCORE_FOR_AUTO_APPROVAL: z.coerce.number().default(75),
});

const parsed = schema.safeParse(process.env);

if (!parsed.success) {
  // eslint-disable-next-line no-console
  console.error('Invalid environment configuration:');
  for (const issue of parsed.error.issues) {
    // eslint-disable-next-line no-console
    console.error(`  ${issue.path.join('.')}: ${issue.message}`);
  }
  process.exit(1);
}

export const env = parsed.data;
export type Env = typeof env;
