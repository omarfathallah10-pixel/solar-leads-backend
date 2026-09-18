import { Prisma } from '@prisma/client';
import { logger } from '../lib/logger';
import { isUniqueViolation, prisma } from '../lib/prisma';

/**
 * Creates the Lead rows that the pipeline screen actually displays.
 *
 * This step was missing entirely: discovery created Companies and
 * CompanySites, enrichment created Contacts, and nothing ever created a Lead —
 * so the pipeline stayed empty no matter how many buildings were swept.
 *
 * ONE LEAD PER SITE, not per company. A hotel group with eleven properties is
 * eleven leads, because the solar economics — and the sales conversation — are
 * per building.
 *
 * A lead is created with NO CONTACT if none exists yet. That is deliberate and
 * matches the UI, which renders "needs a contact" and disables the approve
 * checkbox for those rows. A measured 4,000 m² roof with no named contact is
 * genuinely valuable: it is a qualified building waiting for one phone call.
 * Withholding it until a contact appears hides the pipeline's real size.
 */
export async function ensureLeadForSite(siteId: string): Promise<string | null> {
  const site = await prisma.companySite.findUnique({
    where: { id: siteId },
    include: { company: true },
  });
  if (!site) return null;

  // Idempotent: re-running enrichment over the same site must not duplicate.
  const existing = await prisma.lead.findFirst({
    where: { siteId },
    select: { id: true },
  });
  if (existing) return existing.id;

  // Attach the company's best available contact, if any. Ranking mirrors the
  // scoring engine's view of contact quality: a named senior person beats a
  // generic info@ address.
  const contact = await prisma.contact.findFirst({
    where: { companyId: site.companyId, email: { not: null } },
    orderBy: [
      { isPrimary: 'desc' },
      { emailStatus: 'asc' }, // enum order puts 'valid' ahead of 'invalid'
      { createdAt: 'asc' },
    ],
    select: { id: true },
  });

  try {
    const lead = await prisma.lead.create({
      data: {
        companyId: site.companyId,
        siteId: site.id,
        contactId: contact?.id ?? null,
        sectorId: site.company.sectorId,
        source: 'osm',
        sourceRef: site.label,
        status: 'new',
      },
      select: { id: true },
    });
    return lead.id;
  } catch (err) {
    // The partial unique index on (company_id, contact_id) can reject this if
    // another site already claimed the only contact. Retry without one rather
    // than losing the building — a contactless lead is still a real lead.
    if (isUniqueViolation(err) && contact) {
      const fallback = await prisma.lead.create({
        data: {
          companyId: site.companyId,
          siteId: site.id,
          contactId: null,
          sectorId: site.company.sectorId,
          source: 'osm',
          sourceRef: site.label,
          status: 'new',
        },
        select: { id: true },
      });
      return fallback.id;
    }
    logger.warn({ err, siteId }, 'could not create lead for site');
    return null;
  }
}

/**
 * Back-fills a newly discovered contact onto leads that have none.
 *
 * Contact discovery runs after a lead already exists, so without this the
 * pipeline fills up with permanently un-emailable rows even once an address
 * has been found.
 */
export async function attachContactToLeads(companyId: string): Promise<number> {
  const contact = await prisma.contact.findFirst({
    where: { companyId, email: { not: null } },
    orderBy: [{ isPrimary: 'desc' }, { createdAt: 'asc' }],
    select: { id: true },
  });
  if (!contact) return 0;

  // One lead only. The unique index allows a contact to back exactly one lead
  // per company, and picking the highest-scoring one puts the contact where it
  // is most useful.
  const candidate = await prisma.lead.findFirst({
    where: { companyId, contactId: null, status: { in: ['new', 'enriching', 'scored'] } },
    orderBy: [{ currentScore: Prisma.SortOrder.desc }],
    select: { id: true },
  });
  if (!candidate) return 0;

  try {
    await prisma.lead.update({
      where: { id: candidate.id },
      data: { contactId: contact.id },
    });
    return 1;
  } catch (err) {
    if (isUniqueViolation(err)) return 0; // already attached elsewhere
    throw err;
  }
}
