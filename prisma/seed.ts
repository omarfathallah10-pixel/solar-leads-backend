import { PrismaClient } from '@prisma/client';
import { MODEL_V1 } from '../src/scoring/engine';

const prisma = new PrismaClient();

/**
 * Sector profiles.
 *
 * loadFactor and daytimeAlignment come from typical commercial load-profile
 * literature and should be replaced with measured data as soon as you have
 * bills from real customers — these are informed starting values, not truth.
 *
 * capacityBand is the important one: it normalises system size WITHIN each
 * sector so a 30 kWp yacht can score as a strong marine lead while a 30 kWp
 * factory scores as a weak industrial one.
 */
const SECTORS = [
  {
    key: 'industrial_cold_storage', name: 'Cold Storage & Cold Chain',
    loadFactor: 0.85, daytimeAlignment: 0.75, usableRoofFactor: 0.65,
    // Band tightened from an initial 150-3000. A 3 MWp cold store is rare; with
    // the ceiling that high, a genuinely large 700 kWp site normalised to only
    // 0.52 and scored as merely average. Bands must reflect the real
    // distribution of the sector, not its theoretical maximum.
    capacityBandLowKwp: 100, capacityBandHighKwp: 1500,
    painPoints: [
      'refrigeration running 24/7 on grid tariffs that keep climbing',
      'product-loss risk during outages',
      'diesel backup costs during peak-tariff hours',
    ],
  },
  {
    key: 'industrial_general', name: 'Industrial & Manufacturing',
    loadFactor: 0.70, daytimeAlignment: 0.80, usableRoofFactor: 0.60,
    capacityBandLowKwp: 100, capacityBandHighKwp: 5000,
    painPoints: [
      'energy as a rising share of production cost',
      'grid instability disrupting production lines',
      'customer and export-market pressure to cut Scope 2 emissions',
    ],
  },
  {
    key: 'logistics_warehouse', name: 'Logistics & Warehousing',
    loadFactor: 0.45, daytimeAlignment: 0.85, usableRoofFactor: 0.75,
    capacityBandLowKwp: 200, capacityBandHighKwp: 6000,
    painPoints: [
      'large roofs generating no return',
      'EV fleet charging load arriving faster than the grid connection allows',
    ],
  },
  {
    key: 'hospitality_hotel', name: 'Hotels & Tourist Facilities',
    loadFactor: 0.60, daytimeAlignment: 0.55, usableRoofFactor: 0.40,
    capacityBandLowKwp: 50, capacityBandHighKwp: 1500,
    painPoints: [
      'air-conditioning load through the hottest hours',
      'guest-facing sustainability credentials and certification requirements',
    ],
  },
  {
    key: 'hospitality_eco_remote', name: 'Eco-Resorts & Remote Hospitality',
    loadFactor: 0.65, daytimeAlignment: 0.60, usableRoofFactor: 0.35,
    capacityBandLowKwp: 30, capacityBandHighKwp: 800,
    painPoints: [
      'diesel generation at several times grid cost',
      'fuel logistics to a remote site',
      'generator noise degrading the guest experience',
    ],
  },
  {
    key: 'marine_marina', name: 'Marine, Yachts & Offshore',
    // Small systems, high value per Wp. The narrow capacity band is what keeps
    // marine leads competitive against 3 MWp industrial roofs.
    loadFactor: 0.50, daytimeAlignment: 0.60, usableRoofFactor: 0.30,
    capacityBandLowKwp: 5, capacityBandHighKwp: 120,
    painPoints: [
      'shore-power availability and cost',
      'generator runtime at anchor',
      'marine-grade equipment durability in salt air',
    ],
  },
  {
    key: 'real_estate_commercial', name: 'Commercial Real Estate & Developments',
    loadFactor: 0.50, daytimeAlignment: 0.85, usableRoofFactor: 0.55,
    capacityBandLowKwp: 100, capacityBandHighKwp: 4000,
    painPoints: [
      'common-area energy costs passed to tenants',
      'green building certification requirements',
      'tenant demand for renewable supply',
    ],
  },
  {
    key: 'real_estate_residential', name: 'Residential Compounds',
    loadFactor: 0.40, daytimeAlignment: 0.50, usableRoofFactor: 0.45,
    capacityBandLowKwp: 50, capacityBandHighKwp: 2000,
    painPoints: ['common-area and pumping loads', 'service-charge pressure from residents'],
  },
  {
    key: 'utility_scale_epc', name: 'Utility-Scale & EPC Subcontracting',
    loadFactor: 0.90, daytimeAlignment: 0.90, usableRoofFactor: 0.45,
    capacityBandLowKwp: 1000, capacityBandHighKwp: 100000,
    painPoints: ['subcontractor capacity and schedule risk', 'local delivery partnerships'],
  },
];

const INTRO_TEMPLATE_EN = `Hi {{firstName}},

I came across {{companyName}}{{#if city}} in {{city}}{{/if}} while mapping {{sectorPainPoint}} in the area.

{{#if roofAreaM2}}Looking at the site from above, the roof looks like roughly {{roofAreaM2}} m² of usable area — enough for something in the region of {{estimatedKwp}} kWp{{#if estimatedAnnualMwh}}, or about {{estimatedAnnualMwh}} MWh a year{{/if}}. That is a rough remote estimate, not a survey, so treat it as a starting point rather than a number to plan around.

{{/if}}We have delivered {{portfolioReference}}, so this is familiar ground for us.

Worth a short call to see whether the numbers hold up for your site? Happy to send a one-page indicative estimate first if that is more useful.

Best regards,
{{senderName}}

---
Not the right person, or not interested? Reply "no thanks" or use this link and I will not contact you again: {{unsubscribeUrl}}`;

async function main() {
  for (const sector of SECTORS) {
    await prisma.sector.upsert({
      where: { key: sector.key },
      create: sector,
      update: sector,
    });
  }
  console.log(`Seeded ${SECTORS.length} sectors`);

  await prisma.scoringModel.upsert({
    where: { version: MODEL_V1.version },
    create: {
      version: MODEL_V1.version,
      name: 'Initial hand-set weights',
      isActive: true,
      config: MODEL_V1 as unknown as object,
      notes:
        'Hand-set from domain judgement, not fitted to data. Do NOT tune until ' +
        'there are 150-200 leads with known outcomes — before that, any ' +
        'adjustment is superstition.',
    },
    update: {},
  });

  for (const [key, weight] of Object.entries(MODEL_V1.weights)) {
    const model = await prisma.scoringModel.findUnique({ where: { version: MODEL_V1.version } });
    if (!model) continue;
    await prisma.scoringFactor.upsert({
      where: { modelId_key: { modelId: model.id, key } },
      create: { modelId: model.id, key, label: key.replace(/_/g, ' '), weight },
      update: { weight },
    });
  }
  console.log('Seeded scoring model v1');

  await prisma.emailTemplate.upsert({
    where: { key_version: { key: 'intro_generic_en', version: 1 } },
    create: {
      key: 'intro_generic_en',
      version: 1,
      language: 'en',
      subjectTemplate: 'Solar potential at {{companyName}}{{#if city}} — {{city}}{{/if}}',
      bodyTemplate: INTRO_TEMPLATE_EN,
      requiredVars: ['firstName', 'companyName', 'senderName', 'unsubscribeUrl'],
      isActive: true,
    },
    update: {},
  });
  console.log('Seeded intro template');

  const admin = await prisma.user.upsert({
    where: { email: 'admin@example.com' },
    create: { email: 'admin@example.com', fullName: 'Admin', role: 'admin' },
    update: {},
  });
  console.log(`Seeded admin user ${admin.id}`);
}

main()
  .catch((e) => { console.error(e); process.exit(1); })
  .finally(() => prisma.$disconnect());
