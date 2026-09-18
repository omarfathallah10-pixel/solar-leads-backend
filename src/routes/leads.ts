import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { prisma } from '../lib/prisma';
import { approveLeadForOutreach } from '../outreach/approveLead';
import { jobId, scoringQueue } from '../queues';

const listQuery = z.object({
  sectorId: z.coerce.number().optional(),
  status: z.string().optional(),
  minScore: z.coerce.number().min(0).max(100).optional(),
  maxScore: z.coerce.number().min(0).max(100).optional(),
  minKwp: z.coerce.number().optional(),
  ownerUserId: z.string().uuid().optional(),
  countryCode: z.string().length(2).optional(),
  hasContact: z.coerce.boolean().optional(),
  /** Hides leads whose score rests on too little real data. */
  minCoverage: z.coerce.number().min(0).max(1).optional(),
  page: z.coerce.number().min(1).default(1),
  pageSize: z.coerce.number().min(1).max(200).default(50),
  sort: z.enum(['score', 'created', 'company']).default('score'),
});

export const leadRoutes: FastifyPluginAsync = async (app) => {
  /**
   * Pipeline grid. Server-side filtering and pagination throughout — never ship
   * 10,000 rows to the browser. Backed by idx_leads_triage
   * (status, sector_id, current_score DESC).
   */
  app.get('/leads', async (req, reply) => {
    const q = listQuery.parse(req.query);

    const where = {
      ...(q.sectorId ? { sectorId: q.sectorId } : {}),
      ...(q.status ? { status: q.status as never } : {}),
      ...(q.ownerUserId ? { ownerUserId: q.ownerUserId } : {}),
      ...(q.hasContact ? { contactId: { not: null } } : {}),
      ...(q.minScore != null || q.maxScore != null
        ? { currentScore: { ...(q.minScore != null ? { gte: q.minScore } : {}),
                            ...(q.maxScore != null ? { lte: q.maxScore } : {}) } }
        : {}),
      ...(q.minCoverage != null ? { scoreCoverage: { gte: q.minCoverage } } : {}),
      ...(q.countryCode ? { company: { hqCountryCode: q.countryCode } } : {}),
      ...(q.minKwp != null ? { site: { estimatedKwp: { gte: q.minKwp } } } : {}),
    };

    const orderBy =
      q.sort === 'score' ? [{ currentScore: 'desc' as const }]
        : q.sort === 'created' ? [{ createdAt: 'desc' as const }]
          : [{ company: { name: 'asc' as const } }];

    const [total, rows] = await Promise.all([
      prisma.lead.count({ where }),
      prisma.lead.findMany({
        where,
        orderBy,
        skip: (q.page - 1) * q.pageSize,
        take: q.pageSize,
        select: {
          id: true, status: true, currentScore: true, currentScoreBand: true,
          scoreCoverage: true, createdAt: true,
          company: { select: { id: true, name: true, hqCity: true, domain: true } },
          contact: { select: { id: true, fullName: true, title: true, emailStatus: true } },
          site: { select: { id: true, city: true, estimatedKwp: true, roofAreaConfidence: true } },
          sector: { select: { key: true, name: true } },
        },
      }),
    ]);

    return reply.send({ total, page: q.page, pageSize: q.pageSize, rows });
  });

  /** Lead detail, including the factor-by-factor breakdown the UI renders. */
  app.get('/leads/:id', async (req, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);

    const lead = await prisma.lead.findUnique({
      where: { id },
      include: {
        company: true, contact: true, site: true, sector: true,
        scores: { orderBy: { computedAt: 'desc' }, take: 1 },
        messages: {
          orderBy: { createdAt: 'desc' },
          include: { events: { orderBy: { occurredAt: 'asc' } } },
        },
      },
    });
    if (!lead) return reply.code(404).send({ error: 'not found' });

    const sources = await prisma.rawSourceRecord.findMany({
      where: {
        OR: [
          { entityType: 'company', entityId: lead.companyId },
          ...(lead.siteId ? [{ entityType: 'site', entityId: lead.siteId }] : []),
        ],
      },
      select: { sourceKey: true, sourceUrl: true, license: true, collectedAt: true },
    });

    return reply.send({ ...lead, sources });
  });

  /** Approve a single lead. Safe to call repeatedly. */
  app.post('/leads/:id/approve', async (req, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const userId = (req as { userId?: string }).userId;
    if (!userId) return reply.code(401).send({ error: 'unauthenticated' });

    const result = await approveLeadForOutreach({ leadId: id, approvedByUserId: userId });
    // 409 for ALREADY_CONTACTED: the client should show "already sent", not
    // an error toast. Every other refusal is a 422 with a human-readable reason.
    if (!result.ok) {
      const status = result.code === 'ALREADY_CONTACTED' ? 409
        : result.code === 'NOT_FOUND' ? 404 : 422;
      return reply.code(status).send(result);
    }
    return reply.send(result);
  });

  /**
   * Bulk approve. Runs sequentially and returns a per-lead outcome rather than
   * failing the batch: a rep selecting 20 leads where 3 are suppressed should
   * get 17 sends and 3 explanations, not a single opaque error.
   */
  app.post('/leads/bulk-approve', async (req, reply) => {
    const { leadIds } = z.object({
      leadIds: z.array(z.string().uuid()).min(1).max(200),
    }).parse(req.body);
    const userId = (req as { userId?: string }).userId;
    if (!userId) return reply.code(401).send({ error: 'unauthenticated' });

    const results = [];
    for (const leadId of leadIds) {
      results.push({ leadId, ...(await approveLeadForOutreach({ leadId, approvedByUserId: userId })) });
    }
    return reply.send({
      approved: results.filter((r) => r.ok).length,
      skipped: results.filter((r) => !r.ok).length,
      results,
    });
  });

  app.post('/leads/:id/rescore', async (req, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    await scoringQueue.add('score-lead', { leadId: id, force: true },
      { jobId: jobId('score', id, Date.now()) });
    return reply.send({ queued: true });
  });

  /**
   * Manual roof-area override. Sets confidence to 'confirmed', which outranks
   * every automated source and never gets overwritten by a later Google Solar
   * call. A salesperson who has been to the site knows better than the imagery.
   */
  app.patch('/sites/:id/measurements', async (req, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const body = z.object({
      roofAreaM2: z.number().positive().optional(),
      groundAreaM2: z.number().positive().optional(),
      hasExistingSolar: z.boolean().optional(),
      existingSolarKwp: z.number().nonnegative().optional(),
    }).parse(req.body);

    const site = await prisma.companySite.update({
      where: { id },
      data: {
        ...body,
        ...(body.roofAreaM2
          ? { roofAreaSource: 'manual', roofAreaConfidence: 'confirmed' as const }
          : {}),
      },
    });

    const leads = await prisma.lead.findMany({ where: { siteId: id }, select: { id: true } });
    for (const lead of leads) {
      await scoringQueue.add('score-lead', { leadId: lead.id, force: true },
        { jobId: jobId('score', lead.id, Date.now()) });
    }

    return reply.send(site);
  });
};