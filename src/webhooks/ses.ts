import { createVerify } from 'node:crypto';
import type { FastifyPluginAsync } from 'fastify';
import { logger } from '../lib/logger';
import { prisma } from '../lib/prisma';

/**
 * SES delivery/bounce/complaint webhooks via SNS.
 *
 * Only used for the SES (system-mail) path. Graph traffic gets its status from
 * the reply poller and from bounce messages landing in the sending mailbox.
 *
 * ⚠ Signature verification is NOT optional. This endpoint is public and it
 *   writes to the suppression list — an unauthenticated caller could suppress
 *   your entire pipeline with a few dozen forged requests.
 */

const certCache = new Map<string, string>();

async function verifySnsSignature(envelope: Record<string, unknown>): Promise<boolean> {
  const certUrl = String(envelope.SigningCertURL ?? envelope.SigningCertUrl ?? '');
  // Only ever fetch certificates from AWS-owned hosts.
  if (!/^https:\/\/sns\.[a-z0-9-]+\.amazonaws\.com\/.*\.pem$/.test(certUrl)) return false;

  let pem = certCache.get(certUrl);
  if (!pem) {
    const res = await fetch(certUrl);
    if (!res.ok) return false;
    pem = await res.text();
    certCache.set(certUrl, pem);
  }

  // SNS signs a canonical string of specific fields in a fixed order.
  const fields =
    envelope.Type === 'Notification'
      ? ['Message', 'MessageId', 'Subject', 'Timestamp', 'TopicArn', 'Type']
      : ['Message', 'MessageId', 'SubscribeURL', 'Timestamp', 'Token', 'TopicArn', 'Type'];

  const canonical = fields
    .filter((f) => envelope[f] !== undefined)
    .map((f) => `${f}\n${envelope[f]}\n`)
    .join('');

  const verifier = createVerify(envelope.SignatureVersion === '2' ? 'RSA-SHA256' : 'RSA-SHA1');
  verifier.update(canonical, 'utf8');
  return verifier.verify(pem, String(envelope.Signature), 'base64');
}

const EVENT_MAP: Record<string, string> = {
  Delivery: 'delivered', Bounce: 'bounce', Complaint: 'complaint',
  Open: 'open', Click: 'click', Send: 'sent',
};

export const sesWebhooks: FastifyPluginAsync = async (app) => {
  app.post('/webhooks/ses', async (req, reply) => {
    const envelope = req.body as Record<string, unknown>;

    if (!(await verifySnsSignature(envelope))) {
      logger.warn('rejected SNS message with invalid signature');
      return reply.code(403).send({ error: 'invalid signature' });
    }

    if (envelope.Type === 'SubscriptionConfirmation') {
      await fetch(String(envelope.SubscribeURL)); // one-time SNS handshake
      return reply.code(200).send();
    }

    const msg = JSON.parse(String(envelope.Message)) as {
      eventType?: string;
      notificationType?: string;
      mail?: { messageId?: string; timestamp?: string };
      bounce?: { bounceType?: string };
    };

    const providerMessageId = msg.mail?.messageId;
    const eventType = EVENT_MAP[msg.eventType ?? msg.notificationType ?? ''];
    // Always 200 on shapes we do not handle: an unacknowledged SNS message is
    // retried for hours.
    if (!providerMessageId || !eventType) return reply.code(200).send();

    const message = await prisma.outreachMessage.findFirst({
      where: { providerMessageId },
      select: { id: true, leadId: true, toEmail: true, status: true },
    });
    if (!message) return reply.code(200).send();

    try {
      await prisma.$transaction(async (tx) => {
        // providerEventId is UNIQUE. Providers retry aggressively; this turns a
        // duplicate delivery into a no-op instead of double-counting opens or
        // re-suppressing an address that has since recovered.
        await tx.emailEvent.create({
          data: {
            messageId: message.id,
            eventType,
            occurredAt: new Date(msg.mail?.timestamp ?? Date.now()),
            providerEventId: `${providerMessageId}:${eventType}:${msg.mail?.timestamp}`,
            bounceType: msg.bounce?.bounceType ?? null,
            payload: msg as object,
          },
        });

        switch (eventType) {
          case 'delivered':
            await tx.outreachMessage.updateMany({
              where: { id: message.id, status: 'sent' },
              data: { status: 'delivered' },
            });
            break;

          case 'open':
            // Open tracking is unreliable: Apple Mail Privacy Protection and
            // corporate link scanners pre-fetch pixels. Recorded for a
            // directional signal only — never let opens drive scoring.
            await tx.outreachMessage.updateMany({
              where: { id: message.id, status: { in: ['sent', 'delivered'] } },
              data: { status: 'opened', firstOpenedAt: new Date() },
            });
            break;

          case 'bounce':
            await tx.outreachMessage.update({
              where: { id: message.id },
              data: { status: 'bounced', bouncedAt: new Date() },
            });
            if (msg.bounce?.bounceType === 'Permanent') {
              await tx.suppressionEntry.create({
                data: { email: message.toEmail, reason: 'hard_bounce', sourceMessageId: message.id },
              }).catch(() => undefined);
              await tx.contact.updateMany({
                where: { email: message.toEmail },
                data: { emailStatus: 'invalid' },
              });
            }
            break;

          case 'complaint':
            // A spam complaint is a hard stop. A rising complaint rate gets the
            // sending domain blocklisted, which ends the whole programme.
            await tx.outreachMessage.update({
              where: { id: message.id },
              data: { status: 'complained' },
            });
            await tx.suppressionEntry.create({
              data: { email: message.toEmail, reason: 'complaint', sourceMessageId: message.id },
            }).catch(() => undefined);
            await tx.lead.update({
              where: { id: message.leadId },
              data: { status: 'suppressed' },
            });
            break;
        }
      });
    } catch (err) {
      // Duplicate providerEventId lands here. Expected — ack and move on.
      logger.debug({ err, providerMessageId }, 'webhook event already processed');
    }

    return reply.code(200).send();
  });
};
