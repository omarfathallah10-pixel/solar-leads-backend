export type Confidence = 'confirmed' | 'high' | 'medium' | 'low' | 'absent';
export type Band = 'hot' | 'warm' | 'cool' | 'cold' | 'disqualified';

export interface SectorProfile {
  key: string;
  loadFactor: number;
  daytimeAlignment: number;
  usableRoofFactor: number;
  capacityBandLowKwp: number;
  capacityBandHighKwp: number;
}

export interface ScoringInput {
  leadId: string;
  sector: SectorProfile;

  site?: {
    roofAreaM2?: number | null;
    roofAreaConfidence: Confidence;
    groundAreaM2?: number | null;
    ghiKwhM2Day?: number | null;
    hasExistingSolar?: boolean | null;
    existingSolarKwp?: number | null;
    /** 0..100, LOWER = worse grid = better lead. */
    gridReliabilityScore?: number | null;
    kmToGridInfrastructure?: number | null;
    isRemote?: boolean | null;
    distanceFromBaseKm?: number | null;
  } | null;

  company?: {
    ownershipType: 'owner' | 'tenant' | 'mixed' | 'unknown';
    employeeCountEst?: number | null;
    sustainabilitySignals: string[];
  } | null;

  contact?: {
    seniority:
      | 'c_level' | 'vp' | 'director' | 'manager'
      | 'engineer' | 'owner' | 'other' | 'unknown';
    department?: string | null;
    emailStatus: 'unverified' | 'valid' | 'risky' | 'catch_all' | 'invalid' | 'unknown';
  } | null;

  signals?: {
    recentExpansion?: boolean;
    constructionPermit?: boolean;
    publishedTender?: boolean;
    energyRoleHiring?: boolean;
    signalObservedAt?: Date | null;
  } | null;

  isSuppressed: boolean;
}

export interface FactorResult {
  key: string;
  label: string;
  weight: number;
  /** 0..1, or null when there is no data. Null factors leave the denominator. */
  normalized: number | null;
  points: number;
  /** Plain-English justification rendered verbatim in the UI. */
  evidence: string;
  confidence: Confidence;
}

export interface ScoreResult {
  leadId: string;
  score: number;
  band: Band;
  /** Share of total factor weight backed by real data. <0.5 = act with caution. */
  coverage: number;
  factors: FactorResult[];
  gates: string[];
  modelVersion: string;
}

export interface ScoringModelConfig {
  version: string;
  weights: Record<string, number>;
  bands: { hot: number; warm: number; cool: number };
  minCoverageForConfidence: number;
}
