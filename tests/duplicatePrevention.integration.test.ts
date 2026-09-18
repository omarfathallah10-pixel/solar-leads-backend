/**
 * INTEGRATION TEST — requires a live Postgres with migrations applied.
 *
 *   docker compose up -d db
 *   npm run db:deploy && npm run db:seed
 *   npx vitest run tests/duplicatePrevention.integration.test.ts
 *
 * This is the test that matters most in the whole suite. It proves the
 * "one introductory email ever" guarantee holds under genuine concurrency —
 * which no amount of application-level `if (alreadySent)` checking can do.
 *
 * Skipped automatically unless RUN_INTEGRATION=1, so `npm test` stays fast and
 * database-free in CI.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const RUN = process.env.RUN_INTEGRATION === '1';

describe.skipIf(!RUN)('duplicate prevention (integration)', () => {
  let prisma: import('@prisma/client').PrismaClient;
  let approveLeadForOutreach: typeof import('../src/outreach/approveLead').approveLeadForOutreach;
  let leadId: string;
  let userId: string;

  beforeAll(async () => {
    ({ prisma } = await import('../src/lib/prisma'));
    ({ approveLeadForOutreach } = await import('../src/outreach/approveLead'));

    const sector = await prisma.sector.findFirstOrThrow();
    const user = await prisma.user.findFirstOrThrow();
    userId = user.id;

    const company = await prisma.company.create({
      data: {
        name: `Concurrency Test Co ${Date.now()}`,
        normalizedName: `concurrency test co ${Date.now()}`,
        sectorId: sector.id,
      },
    });

    const contact = await prisma.contact.create({
      data: {
        companyId: company.id,
        email: `concurrency-${Date.now()}@example.test`,
        emailStatus: 'valid',
        seniority: 'director',
      },
    });

    // A lawful basis must exist or the approval gate refuses before the index
    // is ever exercised.
    await prisma.consentRecord.create({
      data: {
        subjectEmail: contact.email!,
        contactId: contact.id,
        basis: 'legitimate_interest',
        liaReference: 'LIA-TEST',
      },
    });

    await prisma.sendingIdentity.upsert({
      where: { mailboxEmail: 'test-sender@example.test' },
      create: {
        mailboxEmail: 'test-sender@example.test',
        displayName: 'Test Sender',
        provider: 'msgraph',
        dailyCap: 500,
      },
      update: { isActive: true, dailyCap: 500 },
    });

    const lead = await prisma.lead.create({
      data: {
        companyId: company.id,
        contactId: contact.id,
        sectorId: sector.id,
        source: 'test',
        status: 'scored',
        currentScore: 80,
      },
    });
    leadId = lead.id;
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  it('creates exactly one intro message under 20 concurrent approvals', async () => {
    const attempts = await Promise.all(
      Array.from({ length: 20 }, () =>
        approveLeadForOutreach({ leadId, approvedByUserId: userId }),
      ),
    );

    const succeeded = attempts.filter((r) => r.ok);
    const blocked = attempts.filter((r) => !r.ok && r.code === 'ALREADY_CONTACTED');

    expect(succeeded).toHaveLength(1);
    expect(blocked).toHaveLength(19);

    // The database is the source of truth, not the return values.
    const messages = await prisma.outreachMessage.findMany({
      where: { leadId, messageType: 'intro' },
    });
    expect(messages).toHaveLength(1);
  });

  it('still refuses after the message has been marked sent', async () => {
    await prisma.outreachMessage.updateMany({
      where: { leadId, messageType: 'intro' },
      data: { status: 'sent', sentAt: new Date() },
    });

    const result = await approveLeadForOutreach({ leadId, approvedByUserId: userId });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('ALREADY_CONTACTED');
  });

  it('allows a fresh attempt only after a permanent failure', async () => {
    // 'failed' rows are excluded from the partial index by design, so a
    // genuinely failed send can be retried with a new row.
    await prisma.outreachMessage.updateMany({
      where: { leadId, messageType: 'intro' },
      data: { status: 'failed', lastError: 'simulated permanent failure' },
    });

    const result = await approveLeadForOutreach({ leadId, approvedByUserId: userId });
    expect(result.ok).toBe(true);

    const messages = await prisma.outreachMessage.findMany({
      where: { leadId, messageType: 'intro' },
    });
    // One failed + one fresh attempt.
    expect(messages).toHaveLength(2);
    expect(messages.filter((m) => m.status !== 'failed')).toHaveLength(1);
  });

  it('refuses once the contact is suppressed', async () => {
    const lead = await prisma.lead.findUniqueOrThrow({
      where: { id: leadId },
      include: { contact: true },
    });

    await prisma.outreachMessage.deleteMany({ where: { leadId } });
    await prisma.suppressionEntry.create({
      data: { email: lead.contact!.email!, reason: 'unsubscribe' },
    });

    const result = await approveLeadForOutreach({ leadId, approvedByUserId: userId });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('SUPPRESSED');
  });
});
