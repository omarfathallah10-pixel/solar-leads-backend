/**
 * JSON.stringify throws "Do not know how to serialize a BigInt" on any BigInt.
 *
 * Five models use BigInt autoincrement ids (EmailEvent, AuditLog,
 * RawSourceRecord, WebhookDelivery, ApiUsage), and raw `COUNT(*)` also comes
 * back as BigInt. GET /leads/:id includes messages → events, so without this
 * every lead detail request returns 500.
 *
 * Serialising as a Number rather than a String is safe here: these are
 * autoincrement row ids, and Number.MAX_SAFE_INTEGER is 9,007,199,254,740,991.
 * At a million email events a day that is 24,000 years of headroom.
 */
export function installBigIntSerializer(): void {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (BigInt.prototype as any).toJSON = function toJSON(this: bigint): number | string {
    return this <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(this) : this.toString();
  };
}
