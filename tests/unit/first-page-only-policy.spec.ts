import { test, expect } from '@playwright/test';
import { firstPageOnlyEnabled, assertScopedFirstPageOutcome } from '../../utils/first-page-only-policy';
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
