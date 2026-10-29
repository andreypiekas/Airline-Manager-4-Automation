// A full-fleet live run needs time for repeated, independently confirmed
// departures after collection and pricing. The workflow job has a 29m cap;
// 24m preserves roughly 5m for setup, offline CI and post-run artifacts.
export const LIVE_RUN_TIMEOUT_MS=1_440_000; // 24 minutes
export const LIVE_RUN_FINALIZATION_RESERVE_MS=120_000;
export const MUTATION_COMPLETION_RESERVE_MS=240_000;
export const MUTATION_PHASE_START_MINIMUM_MS=300_000;
// Extra time for optional pricing to finish before the mandatory departure window.
// This is not a reduction of the existing 5-minute departure start gate.
export const OPTIONAL_PRICING_DEPARTURE_HEADROOM_MS=120_000;

/** Reserve the downstream departure gate before optional full-fleet pricing.
 * If demand evidence or budget values are invalid, refuse the optional phase.
 * This does not authorize a departure; all normal gates still apply later.
 */
export function pricingBudgetMinimumBeforeDepartures(
  pricingMinimumMs:number,
  departureMinimumMs:number,
  departureHeadroomMs:number,
  departureEnabled:boolean,
  sufficientDemand:number,
):number {
  const durations=[pricingMinimumMs,departureMinimumMs,departureHeadroomMs];
  if(!durations.every(n=>Number.isSafeInteger(n)&&n>=0))return Number.NaN;
  if(!departureEnabled)return pricingMinimumMs;
  if(!Number.isSafeInteger(sufficientDemand)||sufficientDemand<0)return Number.NaN;
  if(sufficientDemand===0)return pricingMinimumMs;
  const total=pricingMinimumMs+departureMinimumMs+departureHeadroomMs;
  return Number.isSafeInteger(total)?total:Number.NaN;
}

/** Prioritize real departures over optional fare tuning when current routes
 * are unchanged. Rerouted aircraft still require pricing verification before
 * dispatch; invalid evidence never enables this optimization.
 */
export function deferOptionalPricingUntilAfterDepartures(
  departureEnabled:boolean,
  sufficientDemand:number,
  reroutedAircraftCount:number,
):boolean {
  return departureEnabled &&
    Number.isSafeInteger(sufficientDemand) && sufficientDemand>0 &&
    Number.isSafeInteger(reroutedAircraftCount) && reroutedAircraftCount===0;
}

export type RunPhaseBudgetReason = 'TIME_BUDGET_AVAILABLE' | 'RUN_TIME_BUDGET_EXHAUSTED_BEFORE_PHASE';

export interface RunPhaseBudgetDecision {
  phase: string;
  allowed: boolean;
  reason: RunPhaseBudgetReason;
  nowEpochMs: number;
  phaseDeadlineEpochMs: number;
  minimumPhaseMs: number;
  remainingMs: number;
}

/**
 * Pure fail-closed budget check. The deadline must already reserve finalization
 * time for state save/artifacts, so an allowed phase still cannot consume that reserve.
 */
export function evaluateRunPhaseBudget(
  phase: string,
  nowEpochMs: number,
  phaseDeadlineEpochMs: number,
  minimumPhaseMs: number,
): RunPhaseBudgetDecision {
  const valid = Boolean(phase.trim())
    && Number.isFinite(nowEpochMs)
    && Number.isFinite(phaseDeadlineEpochMs)
    && Number.isFinite(minimumPhaseMs)
    && nowEpochMs >= 0
    && phaseDeadlineEpochMs >= 0
    && minimumPhaseMs >= 0;

  const remainingMs = valid ? Math.max(0, Math.floor(phaseDeadlineEpochMs - nowEpochMs)) : 0;
  const allowed = valid && remainingMs >= minimumPhaseMs;

  return {
    phase,
    allowed,
    reason: allowed ? 'TIME_BUDGET_AVAILABLE' : 'RUN_TIME_BUDGET_EXHAUSTED_BEFORE_PHASE',
    nowEpochMs: valid ? Math.floor(nowEpochMs) : 0,
    phaseDeadlineEpochMs: valid ? Math.floor(phaseDeadlineEpochMs) : 0,
    minimumPhaseMs: valid ? Math.floor(minimumPhaseMs) : 0,
    remainingMs,
  };
}

/**
 * Any held aircraft due to exhausted execution time is a partial operational
 * cycle, even when other departures succeeded. A successful GitHub job cannot
 * imply that the fleet was fully dispatched while such holds remain.
 * Fuel/demand-only holds are legitimate and must not cause false failures.
 */
export function hasDepartureBudgetStarvation(entries:ReadonlyArray<{status:string;reason:string}>):boolean {
  return entries.some(e=>e.status==='held' && (
    e.reason==='RUN_TIME_BUDGET_EXHAUSTED_BEFORE_EVALUATION' ||
    e.reason==='RUN_TIME_BUDGET_EXHAUSTED_BEFORE_MUTATION'
  ));
}

/** A previously verified ready/demand-qualified fleet may become stale before dispatch.
 * If a fresh full rescan loses ALL ready targets, zero evaluated is not a
 * verified no-demand cycle. Preserve every identity gate and fail operationally.
 * This is reporting only: it never authorizes a departure or merges snapshots.
 */
export function hasUnreconciledReadyFleetDrift(
  previouslySufficient:number|undefined,
  previouslyReady:number|undefined,
  fullFleetScans:number,
  evaluated:number,
  departed:number
):boolean {
  return Number.isSafeInteger(previouslySufficient)&&previouslySufficient!>0 &&
    Number.isSafeInteger(previouslyReady)&&previouslyReady!>0 &&
    Number.isSafeInteger(fullFleetScans)&&fullFleetScans>0 &&
    evaluated===0&&departed===0;
}

/** A partial Fleet inventory cannot prove that all ready aircraft were handled,
 * even when some individually verified departures were confirmed. This check
 * changes only the final run status; it never authorizes or repeats mutations.
 */
export function assertFullFleetCoverageForGreenStatus(globalComplete:boolean):void {
  if(globalComplete!==true)throw Error('DEMAND_EXECUTION_INCOMPLETE_GLOBAL_FLEET_COVERAGE');
}

/** A skipped production departure phase with observed sufficient demand is operationally incomplete. */
export function isSkippedDeparturePhaseFailure(enabled:boolean,allowed:boolean,sufficientDemand:number):boolean {
  return enabled && !allowed && Number.isSafeInteger(sufficientDemand) && sufficientDemand > 0;
}
