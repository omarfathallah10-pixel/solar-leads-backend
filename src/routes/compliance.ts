import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { verifyUnsubscribeToken } from '../email/unsubscribe';
import { logger } from '../lib/logger';
import { isUniqueViolation, prisma } from '../lib/prisma';

export const complianceRoutes: FastifyPluginAsync = async (app) => {
  /**
   * One-click unsubscribe. No login, no confirmation step, no dark pattern.
   * An opt-out that requires authentication is not a working opt-out.
   *
   * Handles both GET (link click) and POST (List-Unsubscribe-Post one-click).
   */
  const handleUnsubscribe = async (token: string): Promise<{ ok: boolean; message: string }> => {
    const payload = verifyUnsubscribeToken(token);
    if (!payload) return { ok: false, message: 'This unsubscribe link is not valid.' };

    // The uniqueness of suppression_list.email is a PARTIAL index, which Prisma
    // does not know about, so `upsert` is unavailable here. Insert and swallow
    // the duplicate: already-unsubscribed is a success, not an error.
    await prisma.suppressionEntry
      .create({
        data: {
          email: payload.email,
          reason: 'unsubscribe',
          sourceMessageId: payload.messageId,
        },
      })
      .catch((err) => {
        if (!isUniqueViolation(err)) throw err;
      });

    const message = await prisma.outreachMessage.findUnique({
      where: { id: payload.messageId },
      select: { leadId: true },
    });
    if (message) {
      await prisma.lead.update({
        where: { id: message.leadId },
        data: { status: 'suppressed' },
      }).catch(() => undefined);
    }

    logger.info({ messageId: payload.messageId }, 'unsubscribe processed');
    return { ok: true, message: 'You have been unsubscribed. You will not be contacted again.' };
  };

  app.get('/u/:token', async (req, reply) => {
    const { token } = z.object({ token: z.string() }).parse(req.params);
    const result = await handleUnsubscribe(token);
    return reply.type('text/html').send(
      `<!doctype html><meta charset="utf-8"><title>Unsubscribe</title>` +
      `<body style="font-family:system-ui;max-width:34rem;margin:4rem auto;padding:0 1rem">` +
      `<h1>${result.ok ? 'Unsubscribed' : 'Link not valid'}</h1><p>${result.message}</p></body>`,
    );
  });

  app.post('/u/:token', async (req, reply) => {
    const { token } = z.object({ token: z.string() }).parse(req.params);
    await handleUnsubscribe(token);
    return reply.code(200).send();
  });

  /** Manual suppression: "never contact this company again". */
  app.post('/suppressions', async (req, reply) => {
    const body = z.object({
      email: z.string().email().optional(),
      domain: z.string().optional(),
      reason: z.string().default('manual'),
      notes: z.string().optional(),
    }).refine((b) => b.email || b.domain, { message: 'email or domain required' })
      .parse(req.body);

    const entry = await prisma.suppressionEntry.create({ data: body });
    return reply.code(201).send(entry);
  });

  /**
   * GDPR Art. 15 access request. Returns everything held about a subject,
   * including provenance — Art. 14 requires telling people where the data
   * came from, which is why raw_source_records exists.
   */
  app.get('/dsr/export', async (req, reply) => {
    const { email } = z.object({ email: z.string().email() }).parse(req.query);

    const contacts = await prisma.contact.findMany({
      where: { email },
      include: { company: true, leads: true },
    });
    const messages = await prisma.outreachMessage.findMany({
      where: { toEmail: email },
      include: { events: true },
    });
    const consents = await prisma.consentRecord.findMany({ where: { subjectEmail: email } });
    const suppressions = await prisma.suppressionEntry.findMany({ where: { email } });
    const sources = await prisma.rawSourceRecord.findMany({
      where: { entityType: 'contact', entityId: { in: contacts.map((c) => c.id) } },
    });

    return reply.send({
      subject: email,
      generatedAt: new Date().toISOString(),
      contacts, messages, consents, suppressions,
      dataSources: sources.map((s) => ({
        source: s.sourceKey, url: s.sourceUrl, license: s.license, collectedAt: s.collectedAt,
      })),
    });
  });

  /**
   * GDPR Art. 17 erasure.
   *
   * ⚠ The suppression entry is deliberately KEPT after erasure. Without it, the
   *   next discovery run rediscovers the same person from OSM and emails them
   *   again — a materially worse outcome than retaining one row. Document this
   *   as legitimate-interest retention in your RoPA.
   */
  app.post('/dsr/erase', async (req, reply) => {
    const { email, requestId } = z.object({
      email: z.string().email(),
      requestId: z.string().uuid().optional(),
    }).parse(req.body);

    await prisma.$transaction(async (tx) => {
      await tx.suppressionEntry.create({
        data: { email, reason: 'legal_request', notes: 'Retained post-erasure to prevent re-contact' },
      }).catch(() => undefined);

      const contacts = await tx.contact.findMany({ where: { email }, select: { id: true } });
      const ids = contacts.map((c) => c.id);

      await tx.rawSourceRecord.deleteMany({ where: { entityType: 'contact', entityId: { in: ids } } });
      await tx.consentRecord.deleteMany({ where: { subjectEmail: email } });
      // Message bodies contain the subject's name and address.
      await tx.outreachMessage.updateMany({
        where: { toEmail: email },
        data: { bodyRendered: '[erased]', subjectRendered: '[erased]' },
      });
      await tx.contact.deleteMany({ where: { id: { in: ids } } });

      if (requestId) {
        await tx.dataSubjectRequest.update({
          where: { id: requestId },
          data: { status: 'completed', resolutionNotes: 'Erased; suppression entry retained.' },
        });
      }
    });

    return reply.send({ erased: true, suppressionRetained: true });
  });
};
