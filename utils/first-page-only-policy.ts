import type { ExecutionReport } from '../demand/executor';

/** Explicit production choice: only the current native first page is inspected.
 * The complete Fleet reader must never be an implicit prerequisite here. */
export function firstPageOnlyEnabled(env:Record<string,string|undefined>,dryRun:boolean):boolean {
  const value=(env.DEMAND_FIRST_PAGE_ONLY??'true').trim().toLowerCase();
  if(!['true','false'].includes(value))throw Error('DEMAND_FIRST_PAGE_ONLY_INVALID');
  return !dryRun && env.AUTOMATION_MODE!=='semi-automatic' && value==='true';
}

/** Green in page-only mode means the VERIFIED WINDOW was handled safely;
 * it NEVER means the full fleet was inspected, idle or reconciled. */
export function assertScopedFirstPageOutcome(report:ExecutionReport):void {
  if(report.dryRun||report.halted||report.rollingWindowUnverified===true||!report.completedAt||report.summary.unknown>0||
    report.summary.evaluated<1||report.entries.length!==report.summary.evaluated)
    throw Error('FIRST_PAGE_DISPATCH_INCOMPLETE_OR_UNVERIFIED');
  for(const entry of report.entries){
    if(entry.status==='departed'&&entry.reason==='NATIVE_INFLIGHT_IDENTITY_COUNTDOWN_AND_ONBOARD_CONFIRMED')continue;
    if(entry.status==='held'&&(entry.demand?.decision==='hold_insufficient'||
      ['ALREADY_ATTEMPTED','FUEL_STOCK_INSUFFICIENT_BY_VERIFIED_HISTORY'].includes(entry.reason)))continue;
    // Not verified, no fuel evidence, CAPTCHA/challenge, timer starvation,
    // unclear departure controls or unknown results cannot be green.
    throw Error('FIRST_PAGE_DISPATCH_INCOMPLETE_OR_UNVERIFIED');
  }
}
