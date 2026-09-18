import { createHmac, timingSafeEqual } from 'node:crypto';
import { env } from '../config/env';

/**
 * Stateless, signed unsubscribe tokens.
 *
 * No database lookup, no session, no login. An opt-out link that requires the
 * recipient to authenticate is not a working opt-out, and regulators have said
 * so. HMAC over (messageId|email) with a server secret means the link cannot be
 * forged to suppress an arbitrary third party.
 *
 * Deliberately NOT expiring: an unsubscribe link found in a two-year-old email
 * must still work.
 */

interface UnsubscribePayload {
  messageId: string;
  email: string;
}

function sign(data: string): string {
  return createHmac('sha256', env.UNSUBSCRIBE_SECRET).update(data).digest('base64url');
}

export function signUnsubscribeToken(payload: UnsubscribePayload): string {
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return `${body}.${sign(body)}`;
}

export function verifyUnsubscribeToken(token: string): UnsubscribePayload | null {
  const [body, signature] = token.split('.');
  if (!body || !signature) return null;

  const expected = sign(body);
  const a = Buffer.from(signature);
  const b = Buffer.from(expected);
  // Constant-time compare; length check first because timingSafeEqual throws
  // on length mismatch.
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;

  try {
    const parsed = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
    if (typeof parsed?.messageId !== 'string' || typeof parsed?.email !== 'string') return null;
    return parsed as UnsubscribePayload;
  } catch {
    return null;
  }
}

export function unsubscribeUrl(payload: UnsubscribePayload): string {
  return `${env.APP_URL}/u/${signUnsubscribeToken(payload)}`;
}
