import type { TemplateVars } from '../email/render';

/**
 * Deterministic personalisation helpers.
 *
 * Deterministic, not random: if pain-point selection were random, A/B results
 * would be unattributable noise. Same lead, same variant, every time.
 */

export function pickPainPoint(painPoints: unknown, sectorKey: string): string {
  const list = Array.isArray(painPoints) ? (painPoints as string[]) : [];
  if (list.length === 0) return 'rising energy costs';
  return list[sectorKey.length % list.length] ?? list[0]!;
}

const PORTFOLIO_REFERENCES: Record<string, string> = {
  industrial_cold_storage: 'a 1.2 MWp rooftop system for a cold-chain operator',
  industrial_general: 'multi-megawatt rooftop systems for manufacturing sites',
  logistics_warehouse: 'large-span warehouse rooftop arrays',
  hospitality_hotel: 'an 800 kWp hybrid system for a Red Sea resort',
  hospitality_eco_remote: 'off-grid hybrid systems for remote eco-lodges',
  marine_marina: 'marine-grade arrays on commercial charter vessels',
  real_estate_commercial: 'a 2.4 MWp installation across a commercial compound',
  utility_scale_epc: 'EPC subcontracting on utility-scale projects',
};

export function pickPortfolioReference(sectorKey: string): string {
  return PORTFOLIO_REFERENCES[sectorKey] ?? 'comparable commercial installations';
}

export interface PersonalizationSource {
  firstName: string | null;
  companyName: string;
  city: string | null;
  sectorKey: string;
  painPoints: unknown;
  roofAreaM2: number | null;
  estimatedKwp: number | null;
  estimatedAnnualMwh: number | null;
  senderName: string;
  unsubscribeUrl: string;
}

/**
 * Builds the template variable set.
 *
 * The three site numbers are the highest-converting assets we have. "Your
 * Sadat City facility has roughly 3,800 m² of usable roof, enough for about
 * 690 kWp" is specific, checkable, and obviously not a mail merge — which is
 * the entire justification for the free measurement pipeline.
 */
export function buildTemplateVars(src: PersonalizationSource): TemplateVars {
  return {
    firstName: src.firstName ?? 'there',
    companyName: src.companyName,
    city: src.city ?? '',
    sectorPainPoint: pickPainPoint(src.painPoints, src.sectorKey),
    roofAreaM2: src.roofAreaM2 ? Math.round(src.roofAreaM2).toLocaleString('en-US') : null,
    estimatedKwp: src.estimatedKwp ? Math.round(src.estimatedKwp) : null,
    estimatedAnnualMwh: src.estimatedAnnualMwh
      ? Math.round(src.estimatedAnnualMwh).toLocaleString('en-US')
      : null,
    portfolioReference: pickPortfolioReference(src.sectorKey),
    senderName: src.senderName,
    unsubscribeUrl: src.unsubscribeUrl,
  };
}
