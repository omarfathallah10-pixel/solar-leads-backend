import { createHash, createHmac } from 'node:crypto';
import { env } from '../../config/env';
import { PermanentError, TransientError } from '../../lib/errors';
import type { MailProviderAdapter, SendArgs, SendResult } from './types';

/**
 * Amazon SES adapter — for SYSTEM mail only (unsubscribe confirmations,
 * internal digests, DSR acknowledgements). Cold intros go through Graph.
 *
 * Unlike Graph, SES accepts arbitrary headers, so this is also the path to use
 * if outreach volume ever exceeds ~5,000/day and List-Unsubscribe becomes
 * mandatory under bulk-sender rules.
 *
 * Two SES cost traps worth remembering:
 *   · Billing is PER RECIPIENT, not per message. One email to 500 recipients
 *     is 500 billable sends.
 *   · Attachments bill separately per GB. Link to object storage instead.
 *
 * Implemented with SigV4 over fetch rather than the AWS SDK: the SDK pulls in
 * ~15 MB of dependencies for one API call, and this is a budget-first build.
 */

const SERVICE = 'ses';

function sha256Hex(data: string): string {
  return createHash('sha256').update(data, 'utf8').digest('hex');
}

function hmac(key: Buffer | string, data: string): Buffer {
  return createHmac('sha256', key).update(data, 'utf8').digest();
}

function signingKey(secret: string, date: string, region: string): Buffer {
  const kDate = hmac(`AWS4${secret}`, date);
  const kRegion = hmac(kDate, region);
  const kService = hmac(kRegion, SERVICE);
  return hmac(kService, 'aws4_request');
}

export class SesMailProvider implements MailProviderAdapter {
  readonly name = 'ses';

  async send(args: SendArgs): Promise<SendResult> {
    const accessKey = process.env.AWS_ACCESS_KEY_ID;
    const secretKey = process.env.AWS_SECRET_ACCESS_KEY;
    if (!accessKey || !secretKey) {
      throw new PermanentError('AWS credentials not configured', 'SES_NOT_CONFIGURED');
    }

    const region = env.AWS_REGION;
    const host = `email.${region}.amazonaws.com`;
    const path = '/v2/email/outbound-emails';

    const headerLines = Object.entries(args.headers ?? {})
      .map(([k, v]) => `${k}: ${v}`)
      .join('\r\n');

    // v2 SendEmail with a raw MIME payload, so custom headers survive.
    const rawMessage =
      `From: ${args.from.name} <${args.from.email}>\r\n` +
      `To: ${args.to}\r\n` +
      `Subject: ${args.subject}\r\n` +
      `MIME-Version: 1.0\r\n` +
      `Content-Type: text/plain; charset=UTF-8\r\n` +
      (headerLines ? `${headerLines}\r\n` : '') +
      `\r\n${args.text}`;

    const payload = JSON.stringify({
      Content: { Raw: { Data: Buffer.from(rawMessage, 'utf8').toString('base64') } },
      ...(env.SES_CONFIGURATION_SET
        ? { ConfigurationSetName: env.SES_CONFIGURATION_SET }
        : {}),
    });

    const now = new Date();
    const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, '');
    const dateStamp = amzDate.slice(0, 8);

    const canonicalHeaders =
      `content-type:application/json\nhost:${host}\nx-amz-date:${amzDate}\n`;
    const signedHeaders = 'content-type;host;x-amz-date';
    const canonicalRequest = [
      'POST', path, '', canonicalHeaders, signedHeaders, sha256Hex(payload),
    ].join('\n');

    const scope = `${dateStamp}/${region}/${SERVICE}/aws4_request`;
    const stringToSign = [
      'AWS4-HMAC-SHA256', amzDate, scope, sha256Hex(canonicalRequest),
    ].join('\n');
    const signature = hmac(signingKey(secretKey, dateStamp, region), stringToSign)
      .toString('hex');

    const res = await fetch(`https://${host}${path}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Amz-Date': amzDate,
        Authorization:
          `AWS4-HMAC-SHA256 Credential=${accessKey}/${scope}, ` +
          `SignedHeaders=${signedHeaders}, Signature=${signature}`,
      },
      body: payload,
    });

    if (!res.ok) {
      const body = await res.text().catch(() => '');
      if (res.status === 429 || res.status >= 500) {
        throw new TransientError(`SES HTTP ${res.status}: ${body.slice(0, 300)}`);
      }
      throw new PermanentError(
        `SES HTTP ${res.status}: ${body.slice(0, 300)}`,
        `SES_${res.status}`,
      );
    }

    const json = (await res.json()) as { MessageId: string };
    return {
      providerMessageId: json.MessageId,
      rfc822MessageId: `<${json.MessageId}@${region}.amazonses.com>`,
      conversationId: null,
    };
  }
}
