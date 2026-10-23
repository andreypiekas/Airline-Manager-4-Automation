import { expect, test } from '@playwright/test';
import { communityRoutePriceScenarios } from '../../optimization/community-route-prices';

test('AM4 community theoretical fares in both game modes are only read-only references', () => {
  const result = communityRoutePriceScenarios(
    1000, { Y: 80, J: 10, F: 2 }, { Y: 100, J: 5, F: 100 }
  );
  expect(result).not.toBeNull();
  expect(result).toMatchObject({
    source: 'abc8747/am4',
    referenceDemandPeriod: 'static-daily',
    gameModeVerified: false,
    revenueIsUpperBound: true,
    comparisonReady: false,
    mutationAuthorized: false,
    scenarios: {
      easy: { fares: { Y: 625, J: 1466, F: 2542 }, grossRevenueCeilingPerDeparture: 62414 },
      realism: { fares: { Y: 493, J: 1186, F: 2012 }, grossRevenueCeilingPerDeparture: 49394 }
    }
  });
});

test('theoretical revenue is never inferred from absent, invalid or zero-capacity data', () => {
  const seats = { Y: 100, J: 0, F: 0 }, demand = { Y: 100, J: 0, F: 0 };
  for (const distance of [NaN, Infinity, -1, 99, 20051]) {
    expect(communityRoutePriceScenarios(distance, seats, demand)).toBeNull();
  }
  expect(communityRoutePriceScenarios(1000, null, demand)).toBeNull();
  expect(communityRoutePriceScenarios(1000, seats, null)).toBeNull();
  expect(communityRoutePriceScenarios(1000, { Y: 0, J: 0, F: 0 }, demand)).toBeNull();
  expect(communityRoutePriceScenarios(1000, seats, { Y: -1, J: 0, F: 0 })).toBeNull();
  expect(communityRoutePriceScenarios(1000, seats, { Y: 1.5, J: 0, F: 0 })).toBeNull();
});

test('static daily demand of zero yields zero gross ceiling, never estimated profit', () => {
  const result = communityRoutePriceScenarios(2500, { Y: 300, J: 0, F: 0 }, { Y: 0, J: 0, F: 0 });
  expect(result?.scenarios.easy.grossRevenueCeilingPerDeparture).toBe(0);
  expect(result?.mutationAuthorized).toBe(false);
});
