import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { digest, discoveryQueue, jobId } from '../queues';
import { SECTOR_SELECTORS } from '../enrichment/overpass';

export const discoveryRoutes: FastifyPluginAsync = async (app) => {
  /**
   * Kick off discovery over a map area drawn in the UI.
   *
   * The bbox area cap is a real guardrail, not bureaucracy: an unbounded
   * Overpass query over a whole country will time out, and if it does not, it
   * will return a hundred thousand polygons that flood the enrichment queue.
   */
  app.post('/discovery/run', async (req, reply) => {
    const body = z.object({
      bbox: z.object({
        south: z.number().min(-90).max(90),
        west: z.number().min(-180).max(180),
        north: z.number().min(-90).max(90),
        east: z.number().min(-180).max(180),
      }),
      sectorKey: z.enum(
        Object.keys(SECTOR_SELECTORS) as [string, ...string[]],
      ),
      minAreaM2: z.number().min(0).default(500),
    }).parse(req.body);

    const spanDeg =
      (body.bbox.north - body.bbox.south) * (body.bbox.east - body.bbox.west);
    if (spanDeg > 4) {
      return reply.code(422).send({
        error: 'Bounding box too large. Split it into smaller areas — Overpass will ' +
          'time out and the enrichment queue will be flooded.',
      });
    }

    const id = jobId('discover', body.sectorKey, digest(body.bbox));

    // The jobId is deterministic so a double-click collapses into one sweep.
    // But BullMQ also returns the EXISTING job when one with that id is already
    // present — including a failed or completed one — so without this, a sweep
    // that failed once silently blocks the same area from ever being re-run,
    // for as long as removeOnFail keeps it (7 days). That is why every area
    // except the one manually cleared appeared to do nothing.
    // Only terminal states are cleared: a job still queued or running is left
    // alone, so a double-click is still collapsed rather than duplicated.
    const existing = await discoveryQueue.getJob(id);
    if (existing) {
      const state = await existing.getState();
      if (state === 'failed' || state === 'completed') await existing.remove();
    }

    const job = await discoveryQueue.add('discover', body, {
      jobId: id,
      attempts: 2,
    });

    return reply.code(202).send({ jobId: job.id, queued: true });
  });

  app.get('/discovery/sectors', async (_req, reply) =>
    reply.send({ sectors: Object.keys(SECTOR_SELECTORS) }),
  );
};