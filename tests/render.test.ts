import { describe, expect, it } from 'vitest';
import { assertFullyRendered, extractVariables, renderTemplate } from '../src/email/render';
import { signUnsubscribeToken, verifyUnsubscribeToken } from '../src/email/unsubscribe';

process.env.UNSUBSCRIBE_SECRET ??= 'x'.repeat(40);
process.env.APP_URL ??= 'http://localhost:3000';

describe('renderTemplate', () => {
  it('substitutes variables', () => {
    expect(renderTemplate('Hi {{name}}', { name: 'Sam' })).toBe('Hi Sam');
  });

  it('renders an if-block when the value is present', () => {
    const out = renderTemplate('A{{#if x}} B{{x}}{{/if}} C', { x: '1' });
    expect(out).toBe('A B1 C');
  });

  it('drops an if-block when the value is missing, without leaking tokens', () => {
    const out = renderTemplate('A{{#if x}} B{{x}}{{/if}} C', { x: null });
    expect(out).toBe('A C');
    expect(out).not.toContain('{{');
  });

  it('extracts variable names including those inside conditionals', () => {
    expect(extractVariables('{{a}} {{#if b}}{{c}}{{/if}}').sort()).toEqual(['a', 'b', 'c']);
  });
});

describe('assertFullyRendered', () => {
  it('throws rather than emailing a raw template token to a prospect', () => {
    expect(() => assertFullyRendered('Hi {{firstName}}', 'body')).toThrow(/unresolved/i);
  });

  it('passes clean text', () => {
    expect(() => assertFullyRendered('Hi Sam', 'body')).not.toThrow();
  });
});

describe('unsubscribe tokens', () => {
  it('round-trips a valid token', () => {
    const token = signUnsubscribeToken({ messageId: 'm1', email: 'a@b.com' });
    expect(verifyUnsubscribeToken(token)).toEqual({ messageId: 'm1', email: 'a@b.com' });
  });

  it('rejects a tampered payload', () => {
    const token = signUnsubscribeToken({ messageId: 'm1', email: 'a@b.com' });
    const [, sig] = token.split('.');
    const forged = `${Buffer.from(
      JSON.stringify({ messageId: 'm1', email: 'victim@other.com' }),
    ).toString('base64url')}.${sig}`;
    expect(verifyUnsubscribeToken(forged)).toBeNull();
  });

  it('rejects garbage', () => {
    expect(verifyUnsubscribeToken('nonsense')).toBeNull();
  });
});
