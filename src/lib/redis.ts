import IORedis from 'ioredis';
import { env } from '../config/env';

/**
 * BullMQ requires maxRetriesPerRequest: null — without it, ioredis aborts
 * in-flight commands during a reconnect and workers drop jobs mid-processing.
 *
 * A `rediss://` URL (hosted Redis such as Upstash) needs TLS. ioredis infers it
 * from the scheme, but hosted providers commonly sit behind a proxy whose
 * certificate does not match the connection hostname, so SNI has to be set
 * explicitly or the handshake fails with a name-mismatch error.
 */
const isTls = env.REDIS_URL.startsWith('rediss://');

export const connection = new IORedis(env.REDIS_URL, {
  maxRetriesPerRequest: null,
  enableReadyCheck: true,
  ...(isTls
    ? { tls: { servername: new URL(env.REDIS_URL).hostname } }
    : {}),
});

connection.on('error', (err) => {
  // Logged once rather than on every reconnect attempt, which otherwise floods
  // the console and hides the real startup error.
  if ('code' in err && (err as { code?: string }).code === 'ECONNREFUSED') {
    if (!warnedOnce) {
      warnedOnce = true;
      // eslint-disable-next-line no-console
      console.error(
        `\n  Redis is not reachable at ${env.REDIS_URL}.` +
          `\n  Queues will not run. Options:` +
          `\n    - Docker:  docker compose up -d redis` +
          `\n    - Windows without Docker: use a hosted Redis and set` +
          `\n      REDIS_URL=rediss://...  (Upstash has a free tier)\n`,
      );
    }
    return;
  }
  // eslint-disable-next-line no-console
  console.error('Redis error:', err.message);
});

let warnedOnce = false;

export async function closeRedis(): Promise<void> {
  await connection.quit();
}
