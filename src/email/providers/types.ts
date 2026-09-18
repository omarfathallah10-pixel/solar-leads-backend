export interface SendArgs {
  from: { email: string; name: string };
  to: string;
  subject: string;
  /** Plain text. Cold intros should not be HTML — see the deliverability notes. */
  text: string;
  /** Custom headers. Provider support varies; see the Graph adapter. */
  headers?: Record<string, string>;
  /** Correlates the send with our own records inside provider metadata. */
  correlationId: string;
}

export interface SendResult {
  providerMessageId: string;
  /** RFC5322 Message-ID. Primary handle for matching inbound replies. */
  rfc822MessageId: string | null;
  /** Graph conversationId, when the provider supplies one. */
  conversationId: string | null;
}

export interface MailProviderAdapter {
  readonly name: string;
  send(args: SendArgs): Promise<SendResult>;
}
