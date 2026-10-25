import type { FirstPageAircraft, FirstPageObservation } from './rolling-first-page';
import { FirstPageProgress } from './rolling-first-page';

/**
 * An observation-only incremental page scheduler.
 *
 * It intentionally does NOT manufacture a full CollectionResult or authorize
 * departures. The gate for real mutations remains with the existing verified
 * fleet + individual-departure executor. This scheduler isolates page churn and
 * records exactly what evidence is still missing before rolling dispatch.
 */
export type RollingStopReason =
  | 'NO_NEW_READY' | 'MAX_WINDOWS' | 'WINDOW_UNVERIFIED'
  | 'IDENTITY_DRIFT' | 'TIME_BUDGET';

export interface RollingWindowSummary {
  iteration: number;
  status: FirstPageObservation['status'];
  routeTotal: number | null;
  visible: number;
  ready: number;
  /** Newly-ready targets in this run (not confirmed departures). */
  newlyReady: number;
  /** Aircraft seen for the first time in this run, regardless of state. */
  firstSeen: number;
  /** Count of distinct aircraft detected over all first-page snapshots. */
  uniqueObserved: number;
  firstPageChanged: boolean;
  /** A partial native page is not a full inventory. */
  mutationAuthorized: false;
}
export interface RollingPageReport {
  schemaVersion: 1;
  mode: 'read-only';
  mutationAuthorized: false;
  totalKnownAircraft: number;
  totalNewReady: number;
  windows: RollingWindowSummary[];
  stopReason: RollingStopReason;
}

const keyOf = (a: Pick<FirstPageAircraft, 'aircraftId' | 'routeId'>) =>
  a.aircraftId + ':' + a.routeId;

/**
 * Tracks identities, changed page ordering and newly-ready targets.
 * A previously seen ID that reappears with a DIFFERENT registration or route
 * is not automatically accepted. Likewise, one route cannot change its aircraft
 * identity within the same scan; both are diagnosed as drift.
 *
 * In-memory candidate history is not a durable departure journal.
 */
export class RollingFirstPagePlanner {
  private readonly observedAircraft = new Map<string, {
    routeId: string; registration: string
  }>();
  private readonly observedRoutes = new Map<string, string>();
  private readonly readySeen = new Set<string>();
  private lastFingerprint: string | null = null;
  private readonly progress = new FirstPageProgress();

  recordConfirmedResult(aircraftId: string, routeId: string, result: 'departed' | 'uncertain') {
    this.progress.recordTerminalResult(aircraftId, routeId, result);
  }

  inspect(observation: FirstPageObservation): {
    status: 'OK' | 'UNVERIFIED' | 'IDENTITY_DRIFT';
    candidates: FirstPageAircraft[];
    summary: Omit<RollingWindowSummary, 'iteration'>;
  } {
    const common = {
      status: observation.status,
      routeTotal: observation.routeTotal,
      visible: observation.visible,
      ready: observation.ready,
      mutationAuthorized: false as const
    };
    const noCandidates = (state:'UNVERIFIED'|'IDENTITY_DRIFT') => ({
      status: state,
      candidates: [],
      summary: {
        ...common, newlyReady: 0, firstSeen: 0,
        uniqueObserved: this.observedAircraft.size, firstPageChanged: false
      }
    });
    if (!['STABLE','SHORT_PAGE'].includes(observation.status) ||
        observation.mutationAuthorized !== false ||
        !Number.isSafeInteger(observation.routeTotal) ||
        observation.routeTotal === null || observation.routeTotal <= 0 ||
        observation.visible !== observation.aircraft.length ||
        observation.visible <= 0 || observation.visible > 20 ||
        observation.ready !== observation.aircraft.filter(a => a.state === 'ready').length) {
      return noCandidates('UNVERIFIED');
    }

    // Verify the whole window without committing any portion if ANY identity
    // conflicts with previous windows. This avoids poisoning the planner
    // after the game swaps an aircraft while requests are in flight.
    const localAircraft = new Set<string>(), localRoutes = new Set<string>();
    for (const a of observation.aircraft) {
      const known = this.observedAircraft.get(a.aircraftId);
      const knownRoute = this.observedRoutes.get(a.routeId);
      if (!/^[1-9]\d*$/.test(a.aircraftId) ||
          !/^[1-9]\d*$/.test(a.routeId) ||
          !a.registration || !['ready','inflight','unavailable'].includes(a.state) ||
          localAircraft.has(a.aircraftId) || localRoutes.has(a.routeId) ||
          (known && (known.routeId !== a.routeId ||
                     known.registration !== a.registration)) ||
          (knownRoute && knownRoute !== a.aircraftId)) {
        return noCandidates('IDENTITY_DRIFT');
      }
      localAircraft.add(a.aircraftId);
      localRoutes.add(a.routeId);
    }

    const currentFingerprint = JSON.stringify([
      observation.routeTotal,
      observation.aircraft.map(a => [a.aircraftId,a.routeId,a.registration,a.state])
    ]);
    const changed = this.lastFingerprint !== null &&
      currentFingerprint !== this.lastFingerprint;
    this.lastFingerprint = currentFingerprint;

    let firstSeen = 0;
    for (const a of observation.aircraft) {
      if (!this.observedAircraft.has(a.aircraftId)) firstSeen++;
      this.observedAircraft.set(a.aircraftId,{
        routeId:a.routeId,registration:a.registration
      });
      this.observedRoutes.set(a.routeId,a.aircraftId);
    }
    const liveCandidates = this.progress.plan(observation).candidates;
    const candidates = liveCandidates.filter(a => !this.readySeen.has(keyOf(a)));
    for (const a of candidates) this.readySeen.add(keyOf(a));
    return {
      status: 'OK',
      candidates,
      summary: {
        ...common, newlyReady:candidates.length, firstSeen,
        uniqueObserved:this.observedAircraft.size,
        firstPageChanged:changed
      }
    };
  }
}

/**
 * Bounded observation-only cycle. Unlike a fixed indexed scan, each sample
 * opens the FIRST native Fleet page again. A new arrival can become ready
 * without invalidating an old page cursor because no old cursor is reused.
 *
 * The provided reader must itself perform the two-sample DOM verification.
 * No scheduler callback is allowed to perform a mutation.
 */
export async function observeRollingFirstPage(
  readWindow: () => Promise<FirstPageObservation>,
  options: {
    maxWindows?: number;
    maxConsecutiveWithoutNewReady?: number;
    deadlineEpochMs?: number;
    pause?: () => Promise<void>;
  } = {}
): Promise<RollingPageReport> {
  const limit = options.maxWindows ?? 3;
  const idleLimit = options.maxConsecutiveWithoutNewReady ?? 2;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 8 ||
      !Number.isSafeInteger(idleLimit) || idleLimit < 1 || idleLimit > 4 ||
      (options.deadlineEpochMs !== undefined &&
       (!Number.isSafeInteger(options.deadlineEpochMs) || options.deadlineEpochMs < 1)))
    throw Error('ROLLING_FIRST_PAGE_SETTINGS_INVALID');

  const planner = new RollingFirstPagePlanner();
  const report:RollingPageReport = {
    schemaVersion:1,mode:'read-only',mutationAuthorized:false,
    totalKnownAircraft:0,totalNewReady:0,windows:[],stopReason:'MAX_WINDOWS'
  };
  let idle=0;
  for (let i=0;i<limit;i++) {
    // No extra Fleet reads if a real mutation deadline is close.
    if (options.deadlineEpochMs !== undefined &&
        Date.now() + 10_000 >= options.deadlineEpochMs) {
      report.stopReason='TIME_BUDGET';
      return report;
    }
    const sampled=await readWindow();
    const next=planner.inspect(sampled);
    report.windows.push({...next.summary,iteration:i+1});
    report.totalKnownAircraft=next.summary.uniqueObserved;
    report.totalNewReady+=next.summary.newlyReady;
    if (next.status === 'UNVERIFIED') {
      report.stopReason='WINDOW_UNVERIFIED';return report;
    }
    if (next.status === 'IDENTITY_DRIFT') {
      report.stopReason='IDENTITY_DRIFT';return report;
    }
    idle=next.summary.newlyReady ? 0 : idle+1;
    if (idle>=idleLimit) {
      report.stopReason='NO_NEW_READY';return report;
    }
    if (i<limit-1 && options.pause) await options.pause();
  }
  return report;
}
