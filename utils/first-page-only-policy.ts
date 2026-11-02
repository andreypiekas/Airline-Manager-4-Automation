import type { ExecutionReport } from '../demand/executor';

/** Explicit production choice: only the current native first page is inspected.
 * The complete Fleet reader must never be an implicit prerequisite here. */
export function firstPageOnlyEnabled(env:Record<string,string|undefined>,dryRun:boolean):boolean {
  const value=(env.DEMAND_FIRST_PAGE_ONLY??'true').trim().toLowerCase();
  if(!['true','false'].includes(value))throw Error('DEMAND_FIRST_PAGE_ONLY_INVALID');
  return !dryRun && env.AUTOMATION_MODE!=='semi-automatic' && value==='true';
}

/** Fixed-category operational summary: never log registration, raw browser
 * errors, route IDs, cabin balances or arbitrary localized reason text. */
export function scopedFirstPageOutcomeDiagnostic(report:ExecutionReport){
  const byCause:Record<string,number>={};
  const allowlisted=new Set([
    'FUEL_STOCK_INSUFFICIENT_BY_VERIFIED_HISTORY',
    'FUEL_REQUIREMENT_UNVERIFIED',
    'FUEL_HOLDING_UNVERIFIED_IN_ROLLING_MODE',
    'FUEL_BUDGET_UNVERIFIED_AFTER_PRIOR_DEPARTURE',
    'PERSISTED_UNCERTAIN_DEPARTURE_BLOCK',
    'PERSISTED_UNCERTAIN_DEPARTURE_RECONCILED_READ_ONLY',
    'CAMPAIGN_NOT_VERIFIED',
    'DEPARTURE_CONTROL_OR_FRESH_DETAILS_UNVERIFIED',
    'REROUTE_PRICING_NOT_VERIFIED',
    'RUN_TIME_BUDGET_EXHAUSTED_BEFORE_MUTATION',
    'RUN_TIME_BUDGET_EXHAUSTED_BEFORE_EVALUATION'
  ]);
  for(const entry of report.entries){
    let cause:string;
    if(entry.status==='departed'&&
       entry.reason==='NATIVE_INFLIGHT_IDENTITY_COUNTDOWN_AND_ONBOARD_CONFIRMED')
      cause='CONFIRMED_DEPARTURE';
    else if(entry.status==='outcome_unknown')cause='UNCERTAIN_DEPARTURE';
    else if(entry.status==='held'&&entry.demand?.decision==='hold_insufficient')
      cause='VERIFIED_DEMAND_HOLD';
    else if(entry.status==='held'&&allowlisted.has(entry.reason))
      cause=entry.reason;
    else cause='UNVERIFIED_OR_UNCLASSIFIED_HOLD';
    byCause[cause]=(byCause[cause]||0)+1;
  }
  return {evaluated:report.summary.evaluated,departed:report.summary.departed,
    held:report.summary.held,unknown:report.summary.unknown,
    windowUnverified:report.rollingWindowUnverified===true,
    postDispatchShortTailReconciled:report.postDispatchShortTailReconciled===true,
    byCause,globalFleetCompleteClaim:false};
}

/** Green in page-only mode means the VERIFIED WINDOW was handled safely;
 * it NEVER means the full fleet was inspected, idle or reconciled. */
export function assertScopedFirstPageOutcome(report:ExecutionReport):void {
  console.log('[ScopedFirstPageOutcome] '+JSON.stringify(scopedFirstPageOutcomeDiagnostic(report)));
  if(report.dryRun||report.halted||report.rollingWindowUnverified===true||!report.completedAt||report.summary.unknown>0||
    (report.summary.evaluated===0&&report.firstPageNoReadyVerified!==true)||
    report.entries.length!==report.summary.evaluated)
    throw Error('FIRST_PAGE_DISPATCH_INCOMPLETE_OR_UNVERIFIED');
  for(const entry of report.entries){
    if(entry.status==='departed'&&entry.reason==='NATIVE_INFLIGHT_IDENTITY_COUNTDOWN_AND_ONBOARD_CONFIRMED')continue;
    if(entry.status==='held'&&(entry.demand?.decision==='hold_insufficient'||
      ['ALREADY_ATTEMPTED','FUEL_STOCK_INSUFFICIENT_BY_VERIFIED_HISTORY',
        // Only AFTER a durable append-only journal resolution with a fresh,
        // strictly verified READY target. No retry in the current run.
        'PERSISTED_UNCERTAIN_DEPARTURE_RECONCILED_READ_ONLY'
      ].includes(entry.reason)))continue;
    // Not verified, no fuel evidence, CAPTCHA/challenge, timer starvation,
    // unclear departure controls or unknown results cannot be green.
    throw Error('FIRST_PAGE_DISPATCH_INCOMPLETE_OR_UNVERIFIED');
  }
}
