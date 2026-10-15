import { test, expect } from '@playwright/test';
import { evaluateRunPhaseBudget, MUTATION_COMPLETION_RESERVE_MS, MUTATION_PHASE_START_MINIMUM_MS, LIVE_RUN_TIMEOUT_MS, LIVE_RUN_FINALIZATION_RESERVE_MS } from '../../utils/run-time-budget';

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


test('production timeout gives departure executor 14 minutes while retaining both reserves',()=>{
  expect(LIVE_RUN_TIMEOUT_MS).toBe(20*60_000);
  expect(LIVE_RUN_FINALIZATION_RESERVE_MS).toBe(120_000);
  expect(MUTATION_COMPLETION_RESERVE_MS).toBe(240_000);
  expect(LIVE_RUN_TIMEOUT_MS-LIVE_RUN_FINALIZATION_RESERVE_MS-MUTATION_COMPLETION_RESERVE_MS).toBe(14*60_000);
  // Keep 4+ minutes outside the Playwright test for dependency/setup and
  // Actions post-run finalizers before the 29-minute workflow-job cap.
  expect(LIVE_RUN_TIMEOUT_MS).toBeLessThan(25*60_000);
});
