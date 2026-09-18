import { env } from '../config/env';
import { fetchJson } from '../lib/http';
import { logger } from '../lib/logger';
import { recordUsage } from './usageLedger';

/**
 * NASA POWER climatology — free, no API key, global coverage.
 *
 * ALLSKY_SFC_SW_DWN is all-sky surface shortwave downward irradiance, i.e. GHI,
 * returned in kWh/m²/day as a long-term monthly climatology plus an ANN annual
 * mean. Because it is a climate normal it never changes, so we fetch once per
 * site and cache permanently.
 *
 * Verify parameter names against current NASA POWER docs before deploying —
 * the API has changed parameter identifiers before.
 */

interface PowerResponse {
  properties?: {
    parameter?: {
      ALLSKY_SFC_SW_DWN?: Record<string, number>;
    };
  };
}

export interface IrradianceResult {
  annualGhiKwhM2Day: number;
  monthly: Record<string, number>;
  source: 'nasa_power';
}

/** NASA POWER uses -999 as its fill value for missing data. */
const FILL_VALUE = -999;

export async function fetchIrradiance(
  latitude: number,
  longitude: number,
): Promise<IrradianceResult | null> {
  const url =
    `${env.NASA_POWER_ENDPOINT}?parameters=ALLSKY_SFC_SW_DWN&community=RE` +
    `&longitude=${longitude.toFixed(4)}&latitude=${latitude.toFixed(4)}&format=JSON`;

  const data = await fetchJson<PowerResponse>(url, {
    label: 'nasa_power:climatology',
    timeoutMs: 30_000,
    retries: 2,
  });

  await recordUsage({ provider: 'nasa_power', sku: 'climatology' });

  const param = data.properties?.parameter?.ALLSKY_SFC_SW_DWN;
  if (!param) {
    logger.warn({ latitude, longitude }, 'NASA POWER returned no irradiance parameter');
    return null;
  }

  const monthly: Record<string, number> = {};
  for (const [key, value] of Object.entries(param)) {
    if (value !== FILL_VALUE) monthly[key] = value;
  }

  // Prefer the API's own annual mean; fall back to averaging the months.
  const annual = monthly.ANN ?? (() => {
    const months = Object.entries(monthly).filter(([k]) => k !== 'ANN').map(([, v]) => v);
    return months.length ? months.reduce((a, b) => a + b, 0) / months.length : null;
  })();

  if (annual == null || !Number.isFinite(annual)) return null;

  return { annualGhiKwhM2Day: annual, monthly, source: 'nasa_power' };
}
