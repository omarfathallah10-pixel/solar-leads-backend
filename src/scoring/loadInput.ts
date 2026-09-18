import { Prisma } from '@prisma/client';
import { env } from '../config/env';
import { prisma } from '../lib/prisma';
import { haversineKm } from './math';
import type { ScoringInput } from './types';

const dec = (v: Prisma.Decimal | null | undefined): number | null =>
  v == null ? null : Number(v);

/**
 * Assembles a ScoringInput from the database. Kept separate from the engine so
 * the engine stays pure and can be replayed over fixtures in tests without a
 * database — which is what makes weight tuning (§4.6) measurable.
 */
export async function loadScoringInput(leadId: string): Promise<ScoringInput | null> {
  const lead = await prisma.lead.findUnique({
    where: { id: leadId },
    include: { company: true, contact: true, site: true, sector: true },
  });

  if (!lead || !lead.sector) return null;

  // A contact is suppressed by their own address OR by a company-wide block.
  let isSuppressed = false;
  if (lead.contact?.email) {
    const hit = await prisma.suppressionEntry.findFirst({
      where: {
        OR: [
          { email: lead.contact.email },
          ...(lead.company.domain ? [{ domain: lead.company.domain }] : []),
        ],
      },
      select: { id: true },
    });
    isSuppressed = hit !== null;
  }

  const site = lead.site;
  let distanceFromBaseKm = dec(site?.distanceFromBaseKm ?? null);
  if (distanceFromBaseKm == null && site) {
    distanceFromBaseKm = haversineKm(
      { lat: env.OPS_BASE_LAT, lon: env.OPS_BASE_LON },
      { lat: site.latitude, lon: site.longitude },
    );
  }

  const signalsRaw = (lead.company.metadata as Record<string, unknown> | null)?.signals as
    | Record<string, unknown>
    | undefined;

  return {
    leadId: lead.id,
    sector: {
      key: lead.sector.key,
      loadFactor: Number(lead.sector.loadFactor),
      daytimeAlignment: Number(lead.sector.daytimeAlignment),
      usableRoofFactor: Number(lead.sector.usableRoofFactor),
      capacityBandLowKwp: Number(lead.sector.capacityBandLowKwp),
      capacityBandHighKwp: Number(lead.sector.capacityBandHighKwp),
    },
    site: site
      ? {
          roofAreaM2: dec(site.roofAreaM2),
          roofAreaConfidence: site.roofAreaConfidence,
          groundAreaM2: dec(site.groundAreaM2),
          ghiKwhM2Day: dec(site.ghiKwhM2Day),
          hasExistingSolar: site.hasExistingSolar,
          existingSolarKwp: dec(site.existingSolarKwp),
          gridReliabilityScore: site.gridReliabilityScore,
          kmToGridInfrastructure: dec(site.kmToGridInfrastructure),
          isRemote: site.isRemote,
          distanceFromBaseKm,
        }
      : null,
    company: {
      ownershipType: lead.company.ownershipType,
      employeeCountEst: lead.company.employeeCountEst,
      sustainabilitySignals: Array.isArray(lead.company.sustainabilitySignals)
        ? (lead.company.sustainabilitySignals as string[])
        : [],
    },
    contact: lead.contact
      ? {
          seniority: lead.contact.seniority,
          department: lead.contact.department,
          emailStatus: lead.contact.emailStatus,
        }
      : null,
    signals: signalsRaw
      ? {
          recentExpansion: Boolean(signalsRaw.recentExpansion),
          constructionPermit: Boolean(signalsRaw.constructionPermit),
          publishedTender: Boolean(signalsRaw.publishedTender),
          energyRoleHiring: Boolean(signalsRaw.energyRoleHiring),
          signalObservedAt: signalsRaw.observedAt
            ? new Date(String(signalsRaw.observedAt))
            : null,
        }
      : null,
    isSuppressed,
  };
}
