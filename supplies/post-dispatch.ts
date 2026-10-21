import type {ExecutionReport} from '../demand/executor';

export type PostDispatchDecision={
  allowed:boolean;
  reason:'DISPATCH_COMPLETED'|'SIMULATION'|'DISPATCH_REPORT_UNVERIFIED'|
   'DISPATCH_INCOMPLETE'|'DEPARTURE_OUTCOME_UNKNOWN'|'NO_CONFIRMED_DEPARTURES';
};

/**
 * A second supply purchase is optional. Only a complete *real* and verified
 * individual-departure cycle may trigger it; merely finding ready aircraft in
 * the earlier simulation never authorizes a purchase.
 *
 * Legitimate holds (insufficient demand/fuel/etc.) can coexist with a complete
 * dispatch evaluation. A time/limit hold cannot.
 */
export function postDispatchSupplyDecision(report:ExecutionReport|null|undefined):PostDispatchDecision{
 const stop=(reason:PostDispatchDecision['reason']):PostDispatchDecision=>({allowed:false,reason});
 if(!report||report.schemaVersion!==1||!Array.isArray(report.entries)||!report.completedAt||
   !Number.isFinite(Date.parse(report.completedAt))||!report.summary ||
   !Number.isSafeInteger(report.summary.evaluated)||
   report.summary.evaluated!==report.entries.length)
   return stop('DISPATCH_REPORT_UNVERIFIED');
 if(report.dryRun)return stop('SIMULATION');
 if(report.halted||report.summary.unknown>0||report.entries.some(e=>
   e.status==='outcome_unknown'||e.status==='attempting'||e.reason==='PREVIOUS_OUTCOME_UNKNOWN'))
   return stop('DEPARTURE_OUTCOME_UNKNOWN');
 if(report.entries.some(e=>e.status==='held'&&(
   e.reason==='EXECUTION_LIMIT'||
   e.reason==='INITIAL_COLLECTION_INCOMPLETE'||
   e.reason==='RUN_TIME_BUDGET_EXHAUSTED_BEFORE_EVALUATION'||
   e.reason==='RUN_TIME_BUDGET_EXHAUSTED_BEFORE_MUTATION'
 )))return stop('DISPATCH_INCOMPLETE');
 const counts={
  departed:report.entries.filter(e=>e.status==='departed').length,
  held:report.entries.filter(e=>e.status==='held').length,
  simulated:report.entries.filter(e=>e.status==='would_depart').length
 };
 if(counts.departed!==report.summary.departed||counts.held!==report.summary.held||
   counts.simulated!==report.summary.simulated||report.summary.simulated!==0)
   return stop('DISPATCH_REPORT_UNVERIFIED');
 if(counts.departed===0)return stop('NO_CONFIRMED_DEPARTURES');
 return {allowed:true,reason:'DISPATCH_COMPLETED'};
}
