import type { Cabins } from '../demand/types';

/**
 * Diagnostic-only adaptation of abc8747/am4's PAX route ticket formula.
 * Upstream: https://github.com/abc8747/am4/blob/d243dcd13d102b28a548b6346af62fbd62c7c9aa/am4/src/route/ticket.rs
 * Copyright (c) 2023 Abraham Cheung, MIT (see docs/AM4_COMMUNITY_ROUTE_PRICING.md).
 *
 * Do not use these references to set live fares, rank net profit, create routes
 * or authorize mutations. The native Auto Price and live evidence remain authoritative.
 */
export type CommunityGameMode = 'easy' | 'realism';
export interface CommunityFareScenario {
  fares: Cabins;
  /** Optimistic one-departure ceiling using STATIC daily reference demand. Not expected revenue. */
  grossRevenueCeilingPerDeparture: number;
}
export interface CommunityRoutePriceScenarios {
  source: 'abc8747/am4';
  sourceCommit: 'd243dcd13d102b28a548b6346af62fbd62c7c9aa';
  sourcePath: 'am4/src/route/ticket.rs';
  referenceDemandPeriod: 'static-daily';
  gameModeVerified: false;
  revenueIsUpperBound: true;
  scenarios: Record<CommunityGameMode, CommunityFareScenario>;
  comparisonReady: false;
  mutationAuthorized: false;
}

const classes = ['Y', 'J', 'F'] as const;
const validCabins = (value: Cabins | null): value is Cabins =>
  value !== null && classes.every(k => Number.isSafeInteger(value[k]) && value[k] >= 0);

function communityPaxFares(distanceKm: number, mode: CommunityGameMode): Cabins {
  const base = mode === 'easy'
    ? { Y: .4 * distanceKm + 170, J: .8 * distanceKm + 560, F: 1.2 * distanceKm + 1200 }
    : { Y: .3 * distanceKm + 150, J: .6 * distanceKm + 500, F: .9 * distanceKm + 1000 };
  // Rust's positive f32 -> u16 truncation, followed by its safety deduction of $2.
  return {
    Y: Math.trunc(base.Y * 1.10) - 2,
    J: Math.trunc(base.J * 1.08) - 2,
    F: Math.trunc(base.F * 1.06) - 2
  };
}

/** Pure offline scenario. Missing or invalid evidence must never become an actionable estimate. */
export function communityRoutePriceScenarios(
  distanceKm: number,
  capacity: Cabins | null,
  referenceDemand: Cabins | null
): CommunityRoutePriceScenarios | null {
  if (!Number.isFinite(distanceKm) || distanceKm < 100 || distanceKm > 20050 ||
      !validCabins(capacity) || !validCabins(referenceDemand) ||
      classes.every(k => capacity[k] === 0)) return null;
  const modes = ['easy', 'realism'] as const;
  const scenarios = {} as Record<CommunityGameMode, CommunityFareScenario>;
  for (const mode of modes) {
    const fares = communityPaxFares(distanceKm, mode);
    if (!classes.every(k => Number.isSafeInteger(fares[k]) && fares[k] > 0)) return null;
    const grossRevenueCeilingPerDeparture = classes.reduce(
      (sum, k) => sum + Math.min(capacity[k], referenceDemand[k]) * fares[k], 0
    );
    if (!Number.isSafeInteger(grossRevenueCeilingPerDeparture)) return null;
    scenarios[mode] = { fares, grossRevenueCeilingPerDeparture };
  }
  return {
    source: 'abc8747/am4',
    sourceCommit: 'd243dcd13d102b28a548b6346af62fbd62c7c9aa',
    sourcePath: 'am4/src/route/ticket.rs',
    referenceDemandPeriod: 'static-daily',
    gameModeVerified: false,
    revenueIsUpperBound: true,
    scenarios,
    comparisonReady: false,
    mutationAuthorized: false
  };
}
