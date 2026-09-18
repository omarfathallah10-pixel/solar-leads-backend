import { PrismaClient } from '@prisma/client';
import { env } from '../config/env';
import { logger } from './logger';

/**
 * Single client per process. In dev, tsx watch reloads the module graph, so we
 * stash the instance on globalThis to avoid exhausting the connection pool
 * with an orphaned client per reload.
 */
const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient };

export const prisma =
  globalForPrisma.prisma ??
  new PrismaClient({
    log:
      env.LOG_LEVEL === 'debug' || env.LOG_LEVEL === 'trace'
        ? [{ emit: 'event', level: 'query' }, 'warn', 'error']
        : ['warn', 'error'],
  });

if (env.NODE_ENV !== 'production') globalForPrisma.prisma = prisma;

export async function disconnectPrisma(): Promise<void> {
  await prisma.$disconnect().catch((err) => logger.error({ err }, 'prisma disconnect failed'));
}

/** Postgres unique_violation. Returned when a duplicate intro email is blocked. */
export const PG_UNIQUE_VIOLATION = 'P2002';

export function isUniqueViolation(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    'code' in err &&
    ((err as { code: string }).code === PG_UNIQUE_VIOLATION ||
      // Raw-SQL path surfaces the native SQLSTATE instead of the Prisma code.
      (err as { code: string }).code === '23505')
  );
}
