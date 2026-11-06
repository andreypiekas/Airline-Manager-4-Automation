import { test, expect } from '@playwright/test';
import { firstPageOnlyEnabled, assertScopedFirstPageOutcome, scopedFirstPageOutcomeDiagnostic } from '../../utils/first-page-only-policy';
import type { ExecutionReport } from '../../demand/executor';

const entry=(status:'departed'|'held',reason:string)=>({
  aircraftId:'101',registration:'TEST-101',routeId:'901',from:'GRU',to:'XAP',
  status,reason,demand:null,actualOnboard:null
});
const report=(status:'departed'|'held',reason:string):ExecutionReport=>({
  schemaVersion:1,dryRun:false,scope:'existing-route-ready-aircraft',
  generatedAt:'2026-10-30T01:00:00.000Z',completedAt:'2026-10-30T01:02:00.000Z',halted:false,
  summary:{evaluated:1,departed:status==='departed'?1:0,held:status==='held'?1:0,unknown:0,simulated:0},
  entries:[entry(status,reason)]
});

test('first page is default production mode, not simulation or semiautomatic',()=>{
  expect(firstPageOnlyEnabled({},false)).toBe(true);
  expect(firstPageOnlyEnabled({DEMAND_FIRST_PAGE_ONLY:'false'},false)).toBe(false);
  expect(firstPageOnlyEnabled({},true)).toBe(false);
  expect(firstPageOnlyEnabled({AUTOMATION_MODE:'semi-automatic'},false)).toBe(false);
  expect(()=>firstPageOnlyEnabled({DEMAND_FIRST_PAGE_ONLY:'1'},false)).toThrow('DEMAND_FIRST_PAGE_ONLY_INVALID');
});
test('verified individual countdown receipt is green for page scope only',()=>{
  expect(()=>assertScopedFirstPageOutcome(report('departed','NATIVE_INFLIGHT_IDENTITY_COUNTDOWN_AND_ONBOARD_CONFIRMED'))).not.toThrow();
});
test('fuel above configured purchase cap may safely hold a ready target',()=>{
  expect(()=>assertScopedFirstPageOutcome(report('held','FUEL_STOCK_INSUFFICIENT_BY_VERIFIED_HISTORY'))).not.toThrow();
});
test('missing control, invalid identity, absent fuel proof and time expiry are failures',()=>{
  for(const reason of ['DEPARTURE_CONTROL_OR_FRESH_DETAILS_UNVERIFIED','INITIAL_COLLECTION_INCOMPLETE',
    'CAMPAIGN_NOT_VERIFIED','FUEL_REQUIREMENT_UNVERIFIED','FUEL_HOLDING_UNVERIFIED_IN_ROLLING_MODE',
    'RUN_TIME_BUDGET_EXHAUSTED_BEFORE_MUTATION','PERSISTED_UNCERTAIN_DEPARTURE_BLOCK']){
    expect(()=>assertScopedFirstPageOutcome(report('held',reason))).toThrow('FIRST_PAGE_DISPATCH_INCOMPLETE_OR_UNVERIFIED');
  }
});
test('zero verified candidates and unknown click results cannot become green',()=>{
  const empty=report('held','DEMAND_BELOW_THRESHOLD');
  empty.summary.evaluated=0;empty.entries=[];
  expect(()=>assertScopedFirstPageOutcome(empty)).toThrow('FIRST_PAGE_DISPATCH_INCOMPLETE_OR_UNVERIFIED');
  const unknown=report('departed','NATIVE_INFLIGHT_IDENTITY_COUNTDOWN_AND_ONBOARD_CONFIRMED');
  unknown.summary.unknown=1;unknown.halted=true;
  expect(()=>assertScopedFirstPageOutcome(unknown)).toThrow('FIRST_PAGE_DISPATCH_INCOMPLETE_OR_UNVERIFIED');
});

test('partially checked first-page targets never count as scoped success',()=>{
  const partial=report('departed','NATIVE_INFLIGHT_IDENTITY_COUNTDOWN_AND_ONBOARD_CONFIRMED');
  partial.rollingWindowUnverified=true;
  expect(()=>assertScopedFirstPageOutcome(partial)).toThrow('FIRST_PAGE_DISPATCH_INCOMPLETE_OR_UNVERIFIED');
});

test('verified insufficient demand is a safe hold even with a localized reason',()=>{
  const insufficient=report('held','Demanda abaixo do percentual minimo.');
  insufficient.entries[0].demand={decision:'hold_insufficient'} as NonNullable<ExecutionReport['entries'][number]['demand']>;
  expect(()=>assertScopedFirstPageOutcome(insufficient)).not.toThrow();
});

test('explicitly verified page with no ready planes is a scoped no-op, not global idleness',()=>{
  const empty=report('held','DEMAND_BELOW_THRESHOLD');
  empty.summary={evaluated:0,departed:0,held:0,unknown:0,simulated:0};
  empty.entries=[];
  empty.firstPageNoReadyVerified=true;
  expect(()=>assertScopedFirstPageOutcome(empty)).not.toThrow();
  empty.firstPageNoReadyVerified=false;
  expect(()=>assertScopedFirstPageOutcome(empty)).toThrow('FIRST_PAGE_DISPATCH_INCOMPLETE_OR_UNVERIFIED');
});


test('run #1227: durable read-only reconciliation of a prior uncertain flight is scoped success, not a re-click',()=>{
  const r=report('held','PERSISTED_UNCERTAIN_DEPARTURE_RECONCILED_READ_ONLY');
  expect(r.summary).toMatchObject({departed:0,held:1,unknown:0});
  expect(()=>assertScopedFirstPageOutcome(r)).not.toThrow();
  // But an UNRESOLVED older uncertainty must remain operationally RED.
  r.entries[0].reason='PERSISTED_UNCERTAIN_DEPARTURE_BLOCK';
  expect(()=>assertScopedFirstPageOutcome(r))
    .toThrow('FIRST_PAGE_DISPATCH_INCOMPLETE_OR_UNVERIFIED');
  // New current-run uncertainties must never be masked by older resolution.
  r.entries[0].reason='PERSISTED_UNCERTAIN_DEPARTURE_RECONCILED_READ_ONLY';
  r.summary.unknown=1;
  expect(()=>assertScopedFirstPageOutcome(r))
    .toThrow('FIRST_PAGE_DISPATCH_INCOMPLETE_OR_UNVERIFIED');
});

 
test('production #1373: operational diagnostic groups Fuel, demand and quarantine without identities',()=>{
 const r=report('held','FUEL_STOCK_INSUFFICIENT_BY_VERIFIED_HISTORY');
 r.entries=[
  {...entry('held','FUEL_STOCK_INSUFFICIENT_BY_VERIFIED_HISTORY'),aircraftId:'sensitive-1'},
  {...entry('held','PERSISTED_UNCERTAIN_DEPARTURE_BLOCK'),aircraftId:'sensitive-2'},
  {...entry('held','local demand message containing private info'),aircraftId:'sensitive-3',
    demand:{decision:'hold_insufficient'} as NonNullable<ExecutionReport['entries'][number]['demand']>}
 ];
 r.summary={evaluated:3,departed:0,held:3,unknown:0,simulated:0};
 const summary=scopedFirstPageOutcomeDiagnostic(r);
 expect(summary.byCause).toEqual({
  FUEL_STOCK_INSUFFICIENT_BY_VERIFIED_HISTORY:1,
  PERSISTED_UNCERTAIN_DEPARTURE_BLOCK:1,
  VERIFIED_DEMAND_HOLD:1
 });
 expect(JSON.stringify(summary)).not.toContain('sensitive');
 expect(JSON.stringify(summary)).not.toContain('private info');
 expect(()=>assertScopedFirstPageOutcome(r)).toThrow('FIRST_PAGE_DISPATCH_INCOMPLETE_OR_UNVERIFIED');
});

test('production #1374: confirmed departure plus unverifiable next window remains red',()=>{
 const r=report('departed','NATIVE_INFLIGHT_IDENTITY_COUNTDOWN_AND_ONBOARD_CONFIRMED');
 r.rollingWindowUnverified=true;
 const d=scopedFirstPageOutcomeDiagnostic(r);
 expect(d.byCause).toEqual({CONFIRMED_DEPARTURE:1});
 expect(d.windowUnverified).toBe(true);
 expect(()=>assertScopedFirstPageOutcome(r)).toThrow('FIRST_PAGE_DISPATCH_INCOMPLETE_OR_UNVERIFIED');
});

test('production #1568: 25 verified departures and one demand hold with nonstandard terminal page is explicitly partial, not failed flights',()=>{
 const r=report('departed','NATIVE_INFLIGHT_IDENTITY_COUNTDOWN_AND_ONBOARD_CONFIRMED');
 r.entries=Array.from({length:25},(_,i)=>({
   ...entry('departed','NATIVE_INFLIGHT_IDENTITY_COUNTDOWN_AND_ONBOARD_CONFIRMED'),
   aircraftId:String(i+1),routeId:String(i+100)
 }));
 r.entries.push({
   ...entry('held','Insufficient demand'),
   aircraftId:'99',routeId:'999',
   demand:{decision:'hold_insufficient'} as NonNullable<ExecutionReport['entries'][number]['demand']>
 });
 r.summary={evaluated:26,departed:25,held:1,unknown:0,simulated:0};
 r.rollingWindowUnverified=true;
 r.rollingTerminalPartialCoverage=true;
 expect(scopedFirstPageOutcomeDiagnostic(r)).toMatchObject({
   windowUnverified:true,partialTerminalCoverage:true,
   globalFleetCompleteClaim:false,
   byCause:{CONFIRMED_DEPARTURE:25,VERIFIED_DEMAND_HOLD:1}
 });
 expect(()=>assertScopedFirstPageOutcome(r)).not.toThrow();
 // It NEVER accepts a new unknown click or an unverified ready target.
 r.summary.unknown=1;
 expect(()=>assertScopedFirstPageOutcome(r)).toThrow('FIRST_PAGE_DISPATCH_INCOMPLETE_OR_UNVERIFIED');
 r.summary.unknown=0;
 r.entries[25].demand=null;
 expect(()=>assertScopedFirstPageOutcome(r)).toThrow('FIRST_PAGE_DISPATCH_INCOMPLETE_OR_UNVERIFIED');
 r.entries.pop();
 r.summary={evaluated:25,departed:25,held:0,unknown:0,simulated:0};
 r.rollingTerminalPartialCoverage=false;
 expect(()=>assertScopedFirstPageOutcome(r)).toThrow('FIRST_PAGE_DISPATCH_INCOMPLETE_OR_UNVERIFIED');
});

test('terminal page partial scope cannot turn a no-departure or halted run green',()=>{
 const r=report('held','FUEL_STOCK_INSUFFICIENT_BY_VERIFIED_HISTORY');
 r.rollingWindowUnverified=true;
 r.rollingTerminalPartialCoverage=true;
 expect(()=>assertScopedFirstPageOutcome(r)).toThrow('FIRST_PAGE_DISPATCH_INCOMPLETE_OR_UNVERIFIED');
 r.entries=[entry('departed','NATIVE_INFLIGHT_IDENTITY_COUNTDOWN_AND_ONBOARD_CONFIRMED')];
 r.summary={evaluated:1,departed:1,held:0,unknown:0,simulated:0};
 r.halted=true;
 expect(()=>assertScopedFirstPageOutcome(r)).toThrow('FIRST_PAGE_DISPATCH_INCOMPLETE_OR_UNVERIFIED');
});
