export interface RouteDecisionCandidate {
  aircraftId:string;
  from:string;
  to:string;
  airportId:string;
  comparisonReady:boolean;
  variableCycleComparison:{
    status:'candidate_dominates'|'keep_current'|'unavailable';
    comparisonReady:boolean;
  };
  candidateVariableCycle:{
    status:'verified_interval'|'unavailable';
    recurringCycleProfitPerHour:{low:number|null;expected:number|null;high:number|null};
    firstCycleAfterSetup:{low:number|null;expected:number|null;high:number|null};
  };
  routeMutationControl:null|{
    nativeClickReady:boolean;endpointVerified:boolean;targetVerified:boolean;
    aircraftIdMatchesContext:boolean;airportIdMatchesContext:boolean;
  };
}
export interface VariableRouteDecision {
  aircraftId:string;
  decision:'would_reroute'|'keep_route'|'hold'|'unavailable';
  selected:null|{from:string;to:string;airportId:string;conservativeProfitPerHour:number;firstCycleLow:number};
  compared:number;
  dominating:number;
  /** False if any inspected candidate lacks an economically verified comparison. */
  candidateSetComplete:boolean;
  reason:string;
  dryRun:true;
  mutationAuthorized:false;
}

const finite=(n:unknown):n is number=>typeof n==='number'&&Number.isFinite(n)&&Math.abs(n)<=Number.MAX_SAFE_INTEGER;

/**
 * Chooses only among already verified conservative cycle comparisons.
 * This is a read-only plan: the native control is checked as evidence but no
 * route mutation is authorized here.
 */
export function planVariableRouteDecision(
  aircraftId:string,
  candidates:RouteDecisionCandidate[]
):VariableRouteDecision {
  const base:VariableRouteDecision={
    aircraftId,decision:'unavailable',selected:null,compared:0,dominating:0,candidateSetComplete:false,
    reason:'ROUTE_COMPARISON_SET_UNAVAILABLE',dryRun:true,mutationAuthorized:false
  };
  if(!/^[1-9]\d*$/.test(aircraftId)||!Array.isArray(candidates)||!candidates.length||
    candidates.some(c=>c.aircraftId!==aircraftId||!/^[A-Z0-9]{3}$/.test(c.from)||!/^[A-Z0-9]{3}$/.test(c.to)||
      c.from===c.to||!/^[1-9]\d*$/.test(c.airportId)))return base;

  const comparable=candidates.filter(c=>c.comparisonReady&&c.variableCycleComparison.comparisonReady&&
    c.variableCycleComparison.status!=='unavailable'&&c.candidateVariableCycle.status==='verified_interval');
  if(!comparable.length)return {...base,decision:'hold',reason:'NO_VERIFIED_VARIABLE_CYCLE_COMPARISON'};
  const candidateSetComplete=comparable.length===candidates.length;
  // A proven improvement over the current route is independently actionable.
  // Other unverified candidates may be better, but cannot negate the proven
  // conservative dominance over the current route. Incomplete review MUST NOT
  // be represented as a global/completed comparison, or authorize KEEP.
  const economicDominant=comparable.filter(c=>c.variableCycleComparison.status==='candidate_dominates'&&
    finite(c.candidateVariableCycle.recurringCycleProfitPerHour.low)&&
    finite(c.candidateVariableCycle.firstCycleAfterSetup.low)&&c.candidateVariableCycle.firstCycleAfterSetup.low!>0);

  if(!economicDominant.length)return {
    ...base,decision:candidateSetComplete?'keep_route':'hold',
    compared:comparable.length,dominating:0,candidateSetComplete,
    reason:candidateSetComplete?'NO_INSPECTED_CANDIDATE_PROVES_CONSERVATIVE_DOMINANCE':
      'INCOMPLETE_VERIFIED_CANDIDATE_COMPARISON_SET'
  };

  economicDominant.sort((a,b)=>
    b.candidateVariableCycle.recurringCycleProfitPerHour.low!-a.candidateVariableCycle.recurringCycleProfitPerHour.low!||
    b.candidateVariableCycle.firstCycleAfterSetup.low!-a.candidateVariableCycle.firstCycleAfterSetup.low!||
    a.to.localeCompare(b.to)
  );
  const best=economicDominant[0];
  const control=best.routeMutationControl;
  if(!control?.nativeClickReady||!control.endpointVerified||!control.targetVerified||
    !control.aircraftIdMatchesContext||!control.airportIdMatchesContext)return {
      ...base,decision:'hold',compared:comparable.length,dominating:economicDominant.length,candidateSetComplete,
      reason:'BEST_DOMINANT_CANDIDATE_MUTATION_CONTROL_UNVERIFIED'
    };

  return {
    ...base,decision:'would_reroute',compared:comparable.length,dominating:economicDominant.length,candidateSetComplete,
    selected:{
      from:best.from,to:best.to,airportId:best.airportId,
      conservativeProfitPerHour:best.candidateVariableCycle.recurringCycleProfitPerHour.low!,
      firstCycleLow:best.candidateVariableCycle.firstCycleAfterSetup.low!
    },
    reason:candidateSetComplete?'BEST_CONSERVATIVE_LOW_BOUND_AMONG_VERIFIED_DOMINATING_CANDIDATES':
      'PROVEN_CONSERVATIVE_IMPROVEMENT_WITH_PARTIAL_CANDIDATE_SET'
  };
}

/** True only when route economics produced a completed safe decision. HOLD remains retryable and never marks comparison ready. */
export function routeDecisionSetComparisonReady(decisions:readonly VariableRouteDecision[]):boolean{
  return decisions.length>0&&decisions.every(d=>d.candidateSetComplete&&
    (d.decision==='keep_route'||d.decision==='would_reroute'));
}
