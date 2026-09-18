import { env } from '../../config/env';
import { PermanentError, TransientError } from '../../lib/errors';
import { logger } from '../../lib/logger';
import type { MailProviderAdapter, SendArgs, SendResult } from './types';

/**
 * Microsoft Graph adapter — sends cold intros FROM the rep's real mailbox.
 *
 * Why this rather than a bulk ESP:
 *   · It literally is the company's official domain and the rep's own mailbox.
 *   · Threading and replies work natively; reply detection comes free.
 *   · $0 marginal cost on existing Microsoft 365 seats.
 *   · At 40–60 sends/day/mailbox it looks like a person, because it nearly is.
 *
 * Azure setup required:
 *   1. App registration, APPLICATION permissions Mail.Send + Mail.ReadWrite,
 *      admin consented.
 *   2. An ApplicationAccessPolicy in Exchange Online restricting the app to a
 *      mail-enabled security group containing ONLY the outreach mailboxes.
 *      Without step 2 the app can send as ANY mailbox in the tenant, which no
 *      security team will sign off on:
 *        New-ApplicationAccessPolicy -AppId <id> -PolicyScopeGroupId \
 *          outreach-senders@company.com -AccessRight RestrictAccess
 *
 * Two constraints worth knowing before you design around this adapter:
 *
 *   · Graph only accepts CUSTOM internet headers prefixed "x-", and caps them
 *     at 5. `List-Unsubscribe` therefore CANNOT be set. At <5,000 sends/day the
 *     bulk-sender rules that mandate it do not apply, so we put a plain-text
 *     opt-out line in the body instead. If you ever move to bulk volume, move
 *     to SES for that traffic.
 *
 *   · sendMail does not return a message id. We create a draft (which returns
 *     id, internetMessageId and conversationId), then send the draft. One extra
 *     round trip buys reliable reply matching, which is the metric that matters.
 */

const GRAPH_BASE = 'https://graph.microsoft.com/v1.0';
const TOKEN_SKEW_MS = 60_000;

interface TokenCache {
  accessToken: string;
  expiresAt: number;
}

let tokenCache: TokenCache | null = null;

async function getAccessToken(): Promise<string> {
  if (tokenCache && Date.now() < tokenCache.expiresAt - TOKEN_SKEW_MS) {
    return tokenCache.accessToken;
  }

  const { MS_GRAPH_TENANT_ID, MS_GRAPH_CLIENT_ID, MS_GRAPH_CLIENT_SECRET } = env;
  if (!MS_GRAPH_TENANT_ID || !MS_GRAPH_CLIENT_ID || !MS_GRAPH_CLIENT_SECRET) {
    throw new PermanentError(
      'Microsoft Graph is not configured (MS_GRAPH_TENANT_ID / CLIENT_ID / CLIENT_SECRET).',
      'GRAPH_NOT_CONFIGURED',
    );
  }

  const res = await fetch(
    `https://login.microsoftonline.com/${MS_GRAPH_TENANT_ID}/oauth2/v2.0/token`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: MS_GRAPH_CLIENT_ID,
        client_secret: MS_GRAPH_CLIENT_SECRET,
        scope: 'https://graph.microsoft.com/.default',
        grant_type: 'client_credentials',
      }),
    },
  );

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    // A bad secret or missing consent will never succeed on retry.
    throw new PermanentError(
      `Graph token request failed: HTTP ${res.status} ${body.slice(0, 300)}`,
      'GRAPH_AUTH_FAILED',
    );
  }

  const json = (await res.json()) as { access_token: string; expires_in: number };
  tokenCache = {
    accessToken: json.access_token,
    expiresAt: Date.now() + json.expires_in * 1000,
  };
  return tokenCache.accessToken;
}

async function graphRequest<T>(
  path: string,
  init: RequestInit & { expectJson?: boolean } = {},
): Promise<T | null> {
  const token = await getAccessToken();
  const res = await fetch(`${GRAPH_BASE}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      ...init.headers,
    },
  });

  if (res.status === 401) {
    // Token rejected mid-flight; drop the cache so the retry re-authenticates.
    tokenCache = null;
    throw new TransientError('Graph returned 401 — token invalidated, will retry');
  }

  if (res.status === 429 || res.status === 503) {
    const retryAfter = Number(res.headers.get('retry-after'));
    throw new TransientError(
      `Graph throttled (HTTP ${res.status})`,
      Number.isFinite(retryAfter) ? retryAfter * 1000 : 30_000,
    );
  }

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    if (res.status >= 500) {
      throw new TransientError(`Graph HTTP ${res.status}: ${body.slice(0, 300)}`);
    }
    throw new PermanentError(
      `Graph HTTP ${res.status}: ${body.slice(0, 300)}`,
      `GRAPH_${res.status}`,
    );
  }

  if (res.status === 202 || res.status === 204 || init.expectJson === false) return null;
  return (await res.json()) as T;
}

interface GraphMessage {
  id: string;
  internetMessageId?: string;
  conversationId?: string;
}

export class GraphMailProvider implements MailProviderAdapter {
  readonly name = 'msgraph';

  async send(args: SendArgs): Promise<SendResult> {
    const mailbox = encodeURIComponent(args.from.email);

    // Graph requires custom headers to start with "x-", max 5. We use two:
    // one to correlate replies, one to mark the traffic for mail-flow rules.
    const internetMessageHeaders = [
      { name: 'x-solarleads-message-id', value: args.correlationId },
      { name: 'x-solarleads-campaign', value: 'intro' },
    ];

    // Step 1: create a draft. Unlike sendMail this returns the ids we need.
    const draft = await graphRequest<GraphMessage>(`/users/${mailbox}/messages`, {
      method: 'POST',
      body: JSON.stringify({
        subject: args.subject,
        // Plain text, deliberately. HTML with images and tracking pixels is what
        // pushes a one-to-one-looking email into Promotions.
        body: { contentType: 'Text', content: args.text },
        toRecipients: [{ emailAddress: { address: args.to } }],
        internetMessageHeaders,
      }),
    });

    if (!draft?.id) {
      throw new TransientError('Graph draft creation returned no message id');
    }

    // Step 2: send it. Returns 202 with no body.
    try {
      await graphRequest(`/users/${mailbox}/messages/${draft.id}/send`, {
        method: 'POST',
        expectJson: false,
      });
    } catch (err) {
      // Clean up the orphaned draft so the rep's Drafts folder does not fill
      // with failed sends. Best-effort: never mask the original error.
      await graphRequest(`/users/${mailbox}/messages/${draft.id}`, {
        method: 'DELETE',
        expectJson: false,
      }).catch(() => undefined);
      throw err;
    }

    logger.info(
      { mailbox: args.from.email, correlationId: args.correlationId },
      'graph send complete',
    );

    return {
      providerMessageId: draft.id,
      rfc822MessageId: draft.internetMessageId ?? null,
      conversationId: draft.conversationId ?? null,
    };
  }
}

// --------------------------------------------------------------------------
// Reply detection
// --------------------------------------------------------------------------

export interface InboundReply {
  graphMessageId: string;
  conversationId: string | null;
  internetMessageId: string | null;
  fromEmail: string | null;
  subject: string | null;
  receivedAt: string;
  preview: string;
}

/**
 * Polls a mailbox for messages received since `since`.
 *
 * Matching strategy, in order of reliability:
 *   1. conversationId — Graph's own thread handle, stored at send time.
 *   2. internetMessageId against In-Reply-To / References.
 * We fetch conversationId here because it is one field and it is exact; the
 * caller joins it against outreach_messages.graph_conversation_id.
 *
 * A 5-minute poll is intentionally simpler than a Graph change-notification
 * subscription: subscriptions expire every ~3 days and need renewal plumbing
 * plus a public HTTPS validation endpoint. Move to subscriptions when latency
 * actually matters.
 */
export async function pollMailboxReplies(
  mailboxEmail: string,
  since: Date,
  limit = 50,
): Promise<InboundReply[]> {
  const mailbox = encodeURIComponent(mailboxEmail);
  const filter = encodeURIComponent(`receivedDateTime ge ${since.toISOString()}`);
  const select = 'id,conversationId,internetMessageId,from,subject,receivedDateTime,bodyPreview';

  const data = await graphRequest<{
    value: Array<{
      id: string;
      conversationId?: string;
      internetMessageId?: string;
      from?: { emailAddress?: { address?: string } };
      subject?: string;
      receivedDateTime: string;
      bodyPreview?: string;
    }>;
  }>(
    `/users/${mailbox}/mailFolders/inbox/messages` +
      `?$filter=${filter}&$select=${select}&$top=${limit}&$orderby=receivedDateTime desc`,
  );

  return (data?.value ?? []).map((m) => ({
    graphMessageId: m.id,
    conversationId: m.conversationId ?? null,
    internetMessageId: m.internetMessageId ?? null,
    fromEmail: m.from?.emailAddress?.address?.toLowerCase() ?? null,
    subject: m.subject ?? null,
    receivedAt: m.receivedDateTime,
    preview: (m.bodyPreview ?? '').slice(0, 500),
  }));
}
