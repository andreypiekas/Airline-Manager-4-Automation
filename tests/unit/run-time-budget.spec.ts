import { test, expect } from '@playwright/test';
import { evaluateRunPhaseBudget, pricingBudgetMinimumBeforeDepartures, deferOptionalPricingUntilAfterDepartures, OPTIONAL_PRICING_DEPARTURE_HEADROOM_MS, hasDepartureBudgetStarvation, isSkippedDeparturePhaseFailure, hasUnreconciledReadyFleetDrift, MUTATION_COMPLETION_RESERVE_MS, MUTATION_PHASE_START_MINIMUM_MS, LIVE_RUN_TIMEOUT_MS, LIVE_RUN_FINALIZATION_RESERVE_MS } from '../../utils/run-time-budget';

test('phase budget allows work only when the full conservative window remains', () => {
  const allowed = evaluateRunPhaseBudget('ticket-pricing', 1_000, 181_000, 120_000);
  expect(allowed).toMatchObject({ allowed: true, reason: 'TIME_BUDGET_AVAILABLE', remainingMs: 180_000 });

  const blocked = evaluateRunPhaseBudget('ticket-pricing', 61_001, 181_000, 120_000);
  expect(blocked).toMatchObject({ allowed: false, reason: 'RUN_TIME_BUDGET_EXHAUSTED_BEFORE_PHASE', remainingMs: 119_999 });
});

test('phase budget is fail-closed for exhausted or invalid evidence', () => {
  expect(evaluateRunPhaseBudget('departures', 200_000, 100_000, 1)).toMatchObject({
    allowed: false,
    reason: 'RUN_TIME_BUDGET_EXHAUSTED_BEFORE_PHASE',
    remainingMs: 0,
  });
  expect(evaluateRunPhaseBudget('', Number.NaN, 100_000, 1)).toMatchObject({
    allowed: false,
    reason: 'RUN_TIME_BUDGET_EXHAUSTED_BEFORE_PHASE',
    remainingMs: 0,
  });
});


test('mutation phases start only with more time than the internal completion reserve',()=>{
  expect(MUTATION_COMPLETION_RESERVE_MS).toBe(240_000);
  expect(MUTATION_PHASE_START_MINIMUM_MS).toBe(300_000);
  expect(MUTATION_PHASE_START_MINIMUM_MS).toBeGreaterThan(MUTATION_COMPLETION_RESERVE_MS);
});


test('production timeout gives departure executor 18 minutes while retaining both reserves',()=>{
  expect(LIVE_RUN_TIMEOUT_MS).toBe(24*60_000);
  expect(LIVE_RUN_FINALIZATION_RESERVE_MS).toBe(120_000);
  expect(MUTATION_COMPLETION_RESERVE_MS).toBe(240_000);
  expect(LIVE_RUN_TIMEOUT_MS-LIVE_RUN_FINALIZATION_RESERVE_MS-MUTATION_COMPLETION_RESERVE_MS).toBe(18*60_000);
  // Keep 4+ minutes outside the Playwright test for dependency/setup and
  // Actions post-run finalizers before the 29-minute workflow-job cap.
  expect(LIVE_RUN_TIMEOUT_MS).toBeLessThan(25*60_000);
});


test('partial or zero departures with time-starved aircraft cannot be a green cycle',()=>{
  const timeHold={status:'held',reason:'RUN_TIME_BUDGET_EXHAUSTED_BEFORE_EVALUATION'};
  const mutationHold={status:'held',reason:'RUN_TIME_BUDGET_EXHAUSTED_BEFORE_MUTATION'};
  const fuelHold={status:'held',reason:'FUEL_STOCK_INSUFFICIENT_BY_VERIFIED_HISTORY'};
  expect(hasDepartureBudgetStarvation([timeHold])).toBe(true); // run #775: all 60 time-held
  expect(hasDepartureBudgetStarvation([fuelHold,mutationHold])).toBe(true); // mixed holds, run #776
  expect(hasDepartureBudgetStarvation([{status:'departed',reason:'NATIVE_CONFIRMED'},timeHold])).toBe(true); // run #804: 16 departed + 35 time-held still incomplete
  expect(hasDepartureBudgetStarvation([fuelHold])).toBe(false); // legitimate resource hold
  expect(hasDepartureBudgetStarvation([{status:'held',reason:'DEMAND_INSUFFICIENT'}])).toBe(false);
  expect(hasDepartureBudgetStarvation([])).toBe(false);
  expect(hasDepartureBudgetStarvation([{status:'held',reason:'INITIAL_COLLECTION_INCOMPLETE'}])).toBe(false);
});


test('production skip with sufficient demand fails instead of silently appearing green',()=>{
  expect(isSkippedDeparturePhaseFailure(true,false,60)).toBe(true); // run #775 demand snapshot
  expect(isSkippedDeparturePhaseFailure(true,false,0)).toBe(false); // no candidate ready
  expect(isSkippedDeparturePhaseFailure(true,true,60)).toBe(false); // execution runs its own gates
  expect(isSkippedDeparturePhaseFailure(false,false,60)).toBe(false); // module deliberately disabled
  expect(isSkippedDeparturePhaseFailure(true,false,Number.NaN)).toBe(false); // invalid evidence never infers eligibility
});

test('run #1013: a complete rescan that loses all ten previously eligible targets cannot be green',()=>{
  // Real #1013: first Routes(151) had ten qualified ready aircraft;
  // Routes(150) required a fresh 282s scan that yielded zero evaluated.
  expect(hasUnreconciledReadyFleetDrift(10,10,1,0,0)).toBe(true);
  expect(hasUnreconciledReadyFleetDrift(10,10,2,0,0)).toBe(true);
  // Normal zero-demand, no rescan, or any actually evaluated target is not this anomaly.
  expect(hasUnreconciledReadyFleetDrift(0,10,1,0,0)).toBe(false);
  expect(hasUnreconciledReadyFleetDrift(10,0,1,0,0)).toBe(false);
  expect(hasUnreconciledReadyFleetDrift(10,10,0,0,0)).toBe(false);
  expect(hasUnreconciledReadyFleetDrift(10,10,1,1,0)).toBe(false);
  expect(hasUnreconciledReadyFleetDrift(10,10,1,1,1)).toBe(false);
  expect(hasUnreconciledReadyFleetDrift(undefined,10,1,0,0)).toBe(false);
  expect(hasUnreconciledReadyFleetDrift(10,Number.NaN,1,0,0)).toBe(false);
});

test('run #966: optional pricing is skipped to preserve a verified departure window',()=>{
  // At 04:15Z, the 04:04Z run had ~11m until its mutation deadline.
  // Pricing used ~7m, leaving only 242668ms (< 300000ms) for departures.
  const min=pricingBudgetMinimumBeforeDepartures(
    MUTATION_PHASE_START_MINIMUM_MS,
    MUTATION_PHASE_START_MINIMUM_MS,
    OPTIONAL_PRICING_DEPARTURE_HEADROOM_MS,
    true,10
  );
  expect(min).toBe(720_000);
  expect(evaluateRunPhaseBudget('ticket-pricing',0,660_000,min).allowed).toBe(false);
  // Skipping optional pricing retains the original departure gate and its
  // independent eligibility/identity/CAPTCHA checks.
  expect(evaluateRunPhaseBudget('departures',0,660_000,MUTATION_PHASE_START_MINIMUM_MS).allowed).toBe(true);
  expect(evaluateRunPhaseBudget('ticket-pricing',0,900_000,min).allowed).toBe(true);
});

test('pricing reservation does not prevent no-demand work or relax safety on invalid inputs',()=>{
  const args=[300_000,300_000,OPTIONAL_PRICING_DEPARTURE_HEADROOM_MS] as const;
  expect(pricingBudgetMinimumBeforeDepartures(...args,true,0)).toBe(300_000);
  expect(pricingBudgetMinimumBeforeDepartures(...args,false,10)).toBe(300_000);
  expect(Number.isNaN(pricingBudgetMinimumBeforeDepartures(...args,true,Number.NaN))).toBe(true);
  expect(Number.isNaN(pricingBudgetMinimumBeforeDepartures(-1,300_000,120_000,true,10))).toBe(true);
  expect(Number.isNaN(pricingBudgetMinimumBeforeDepartures(Number.MAX_SAFE_INTEGER,300_000,120_000,true,10))).toBe(true);
});

test('run #968: ready flights dispatch before optional pricing if no reroute changed fares',()=>{
  // The real run reconciled 138/138, found 11 eligible, spent ~3m on
  // pricing, then re-scanned Routes(139 -> 140) until 16 flights timed out.
  // Scheduling is a priority decision only; it does not authorize any click.
  expect(deferOptionalPricingUntilAfterDepartures(true,11,0)).toBe(true);
  expect(deferOptionalPricingUntilAfterDepartures(true,16,0)).toBe(true);
  // Rerouted aircraft still need freshly verified pricing before dispatch.
  expect(deferOptionalPricingUntilAfterDepartures(true,11,1)).toBe(false);
  expect(deferOptionalPricingUntilAfterDepartures(true,0,0)).toBe(false);
  expect(deferOptionalPricingUntilAfterDepartures(false,11,0)).toBe(false);
  expect(deferOptionalPricingUntilAfterDepartures(true,Number.NaN,0)).toBe(false);
  expect(deferOptionalPricingUntilAfterDepartures(true,11,-1)).toBe(false);
  // Deferred pricing still requires the existing conservative phase budget.
  expect(evaluateRunPhaseBudget('ticket-pricing-after-departures',0,240_000,MUTATION_PHASE_START_MINIMUM_MS).allowed).toBe(false);
  expect(evaluateRunPhaseBudget('ticket-pricing-after-departures',0,360_000,MUTATION_PHASE_START_MINIMUM_MS).allowed).toBe(true);
  expect(hasDepartureBudgetStarvation([{status:'held',reason:'RUN_TIME_BUDGET_EXHAUSTED_BEFORE_MUTATION'}])).toBe(true);
});
