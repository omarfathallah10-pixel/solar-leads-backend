import { Prisma } from '@prisma/client';
import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { prisma } from '../lib/prisma';
import { monthToDateSpendUsd } from '../enrichment/usageLedger';

export const analyticsRoutes: FastifyPluginAsync = async (app) => {
  app.get('/analytics/funnel', async (req, reply) => {
    const { days } = z.object({ days: z.coerce.number().default(30) }).parse(req.query);
    const since = new Date(Date.now() - days * 86_400_000);

    const [sourced, enriched, scored, approved, sent, replied] = await Promise.all([
      prisma.lead.count({ where: { createdAt: { gte: since } } }),
      prisma.companySite.count({ where: { ghiKwhM2Day: { not: null }, updatedAt: { gte: since } } }),
      prisma.lead.count({ where: { currentScore: { gte: 60 }, lastScoredAt: { gte: since } } }),
      prisma.lead.count({ where: { approvedAt: { gte: since } } }),
      prisma.outreachMessage.count({ where: { sentAt: { gte: since } } }),
      prisma.outreachMessage.count({ where: { repliedAt: { gte: since } } }),
    ]);

    return reply.send({ sourced, enriched, scored, approved, sent, replied });
  });

  /**
   * Reply rate by score decile.
   *
   * This is the running verdict on whether the scoring model works. A healthy
   * model shows monotonic lift — the top decile replying at 3–5× the bottom.
   * A flat curve means the model is decorative and no amount of weight-tuning
   * will fix it: the INPUTS need to improve.
   */
  app.get('/analytics/score-deciles', async (_req, reply) => {
    const rows = await prisma.$queryRaw<
      Array<{ decile: number; sent: bigint; replied: bigint; avg_score: number }>
    >(Prisma.sql`
      WITH sent_messages AS (
        SELECT m.id,
               m.replied_at,
               l.current_score,
               NTILE(10) OVER (ORDER BY l.current_score) AS decile
          FROM outreach_messages m
          JOIN leads l ON l.id = m.lead_id
         WHERE m.sent_at IS NOT NULL
           AND l.current_score IS NOT NULL
      )
      SELECT decile,
             COUNT(*)                                        AS sent,
             COUNT(*) FILTER (WHERE replied_at IS NOT NULL)  AS replied,
             AVG(current_score)::float                       AS avg_score
        FROM sent_messages
       GROUP BY decile
       ORDER BY decile DESC
    `);

    return reply.send(
      rows.map((r) => ({
        decile: r.decile,
        sent: Number(r.sent),
        replied: Number(r.replied),
        replyRate: Number(r.sent) > 0 ? Number(r.replied) / Number(r.sent) : 0,
        avgScore: r.avg_score,
      })),
    );
  });

  /** Deliverability health. Build the alerts before you need them. */
  app.get('/analytics/deliverability', async (_req, reply) => {
    const since = new Date(Date.now() - 30 * 86_400_000);

    const [sent, bounced, complained, suppressed] = await Promise.all([
      prisma.outreachMessage.count({ where: { sentAt: { gte: since } } }),
      prisma.outreachMessage.count({ where: { bouncedAt: { gte: since } } }),
      prisma.outreachMessage.count({ where: { status: 'complained', sentAt: { gte: since } } }),
      prisma.suppressionEntry.count(),
    ]);

    const capacity = await prisma.$queryRaw<
      Array<{ mailbox_email: string; sent_today: bigint; daily_cap: number }>
    >(Prisma.sql`
      SELECT si.mailbox_email, si.daily_cap, COUNT(m.id) AS sent_today
        FROM sending_identities si
        LEFT JOIN outreach_messages m
          ON m.sending_identity_id = si.id AND m.sent_at >= date_trunc('day', now())
       WHERE si.is_active
       GROUP BY si.id, si.mailbox_email, si.daily_cap
    `);

    return reply.send({
      sent,
      // Targets: bounce <2%, complaint <0.1%. Above 0.3% complaints, providers
      // start blocking the domain.
      bounceRate: sent > 0 ? bounced / sent : 0,
      complaintRate: sent > 0 ? complained / sent : 0,
      suppressionListSize: suppressed,
      mailboxes: capacity.map((c) => ({
        mailbox: c.mailbox_email,
        sentToday: Number(c.sent_today),
        dailyCap: c.daily_cap,
      })),
    });
  });

  /** Month-to-date API spend against the configured ceiling. */
  app.get('/analytics/api-spend', async (_req, reply) => {
    const start = new Date();
    start.setUTCDate(1);
    start.setUTCHours(0, 0, 0, 0);

    const byProvider = await prisma.apiUsage.groupBy({
      by: ['provider'],
      where: { occurredAt: { gte: start } },
      _sum: { estCostUsd: true, units: true },
    });

    return reply.send({
      monthToDateUsd: await monthToDateSpendUsd(),
      byProvider: byProvider.map((p) => ({
        provider: p.provider,
        calls: p._sum.units ?? 0,
        estCostUsd: Number(p._sum.estCostUsd ?? 0),
      })),
    });
  });
};
