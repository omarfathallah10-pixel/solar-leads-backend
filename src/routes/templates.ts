import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { extractVariables, renderTemplate } from '../email/render';
import { unsubscribeUrl } from '../email/unsubscribe';
import { prisma } from '../lib/prisma';
import { buildTemplateVars } from '../outreach/personalization';

export const templateRoutes: FastifyPluginAsync = async (app) => {
  app.get('/templates', async (_req, reply) => {
    const templates = await prisma.emailTemplate.findMany({
      orderBy: [{ key: 'asc' }, { version: 'desc' }],
      include: { sector: { select: { key: true, name: true } } },
    });

    // Usage counts tell an admin which template is actually carrying the
    // programme before they edit or retire one.
    const usage = await prisma.outreachMessage.groupBy({
      by: ['templateId'],
      _count: { _all: true },
      where: { sentAt: { not: null } },
    });
    const replies = await prisma.outreachMessage.groupBy({
      by: ['templateId'],
      _count: { _all: true },
      where: { repliedAt: { not: null } },
    });

    const sentBy = new Map(usage.map((u) => [u.templateId, u._count._all]));
    const repliedBy = new Map(replies.map((r) => [r.templateId, r._count._all]));

    return reply.send(
      templates.map((t) => ({
        id: t.id,
        key: t.key,
        version: t.version,
        language: t.language,
        sector: t.sector,
        subjectTemplate: t.subjectTemplate,
        bodyTemplate: t.bodyTemplate,
        isActive: t.isActive,
        variables: extractVariables(`${t.subjectTemplate}\n${t.bodyTemplate}`),
        sent: sentBy.get(t.id) ?? 0,
        replied: repliedBy.get(t.id) ?? 0,
      })),
    );
  });

  /**
   * Renders a template against a REAL lead.
   *
   * Previewing against invented data is close to useless: the whole value of
   * the intro email is the specific roof area and system size, and those are
   * exactly the fields most likely to be missing. Rendering against a real lead
   * is what surfaces "this paragraph collapses when there is no measurement".
   */
  app.get('/templates/:id/preview', async (req, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const { leadId } = z.object({ leadId: z.string().uuid().optional() }).parse(req.query);

    const template = await prisma.emailTemplate.findUnique({ where: { id } });
    if (!template) return reply.code(404).send({ error: 'Template not found' });

    const lead = await prisma.lead.findFirst({
      where: leadId ? { id: leadId } : { contactId: { not: null }, siteId: { not: null } },
      orderBy: { currentScore: 'desc' },
      include: { company: true, contact: true, site: true, sector: true },
    });

    if (!lead) {
      return reply.code(422).send({
        error: 'No lead with a contact and a site is available to preview against.',
      });
    }

    const vars = buildTemplateVars({
      firstName: lead.contact?.firstName ?? null,
      companyName: lead.company.name,
      city: lead.site?.city ?? lead.company.hqCity ?? null,
      sectorKey: lead.sector?.key ?? 'industrial_general',
      painPoints: lead.sector?.painPoints,
      roofAreaM2: lead.site?.roofAreaM2 ? Number(lead.site.roofAreaM2) : null,
      estimatedKwp: lead.site?.estimatedKwp ? Number(lead.site.estimatedKwp) : null,
      estimatedAnnualMwh: lead.site?.estimatedAnnualMwh ? Number(lead.site.estimatedAnnualMwh) : null,
      senderName: 'Sample Sender',
      unsubscribeUrl: unsubscribeUrl({ messageId: 'preview', email: 'preview@example.com' }),
    });

    const subject = renderTemplate(template.subjectTemplate, vars);
    const body = renderTemplate(template.bodyTemplate, vars);
    const unresolved = [...new Set(`${subject}\n${body}`.match(/\{\{[^}]*\}\}/g) ?? [])];

    // Which optional blocks dropped out for this lead. A rep should see that the
    // roof-area paragraph vanished, not wonder why the email reads thin.
    const missing = Object.entries(vars)
      .filter(([, v]) => v === null || v === undefined || v === '')
      .map(([k]) => k);

    return reply.send({
      previewedAgainst: {
        leadId: lead.id,
        company: lead.company.name,
        score: lead.currentScore,
      },
      subject,
      body,
      unresolved,
      missingVariables: missing,
    });
  });

  /** Activate or deactivate. Editing ships a NEW version; it never mutates a
   *  template that has already been sent, or old messages become unexplainable. */
  app.patch('/templates/:id', async (req, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const { isActive } = z.object({ isActive: z.boolean() }).parse(req.body);

    const template = await prisma.emailTemplate.update({
      where: { id },
      data: { isActive },
    });
    return reply.send(template);
  });
};
