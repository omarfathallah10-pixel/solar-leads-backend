import pino from 'pino';
import { env } from '../config/env';

export const logger = pino({
  level: env.LOG_LEVEL,
  // Never log a full recipient email or a rendered body at info level: those
  // are personal data and they end up in log aggregation and backups.
  redact: {
    paths: ['req.headers.authorization', 'req.headers.cookie', '*.password', '*.clientSecret'],
    remove: true,
  },
  transport:
    env.NODE_ENV === 'development'
      ? { target: 'pino/file', options: { destination: 1 } }
      : undefined,
});
