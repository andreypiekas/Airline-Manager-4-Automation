// A full-fleet live run needs time for repeated, independently confirmed
// departures after collection and pricing. The workflow job has a 29m cap;
// 24m preserves roughly 5m for setup, offline CI and post-run artifacts.
export const LIVE_RUN_TIMEOUT_MS=1_440_000; // 24 minutes
export const LIVE_RUN_FINALIZATION_RESERVE_MS=120_000;
export const MUTATION_COMPLETION_RESERVE_MS=240_000;
export const MUTATION_PHASE_START_MINIMUM_MS=300_000;

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
 * A green job with no confirmed departures and time-starved aircraft is a
 * false operational success. Resource/demand-only HOLDs are not failures.
 * Never infer that a departure was possible; report only the observed budget gate.
 */
export function hasDepartureBudgetStarvation(entries:ReadonlyArray<{status:string;reason:string}>):boolean {
  if (entries.some(e=>e.status==='departed')) return false;
  return entries.some(e=>e.status==='held' && (
    e.reason==='RUN_TIME_BUDGET_EXHAUSTED_BEFORE_EVALUATION' ||
    e.reason==='RUN_TIME_BUDGET_EXHAUSTED_BEFORE_MUTATION'
  ));
}

/** A skipped production departure phase with observed sufficient demand is operationally incomplete. */
export function isSkippedDeparturePhaseFailure(enabled:boolean,allowed:boolean,sufficientDemand:number):boolean {
  return enabled && !allowed && Number.isSafeInteger(sufficientDemand) && sufficientDemand > 0;
}
