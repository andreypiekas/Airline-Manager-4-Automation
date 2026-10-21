import {test,expect} from '@playwright/test';
import {postDispatchSupplyDecision} from '../../supplies/post-dispatch';
import type {ExecutionEntry,ExecutionReport} from '../../demand/executor';

function sample():ExecutionReport {
 const entry:ExecutionEntry={
  aircraftId:'1',registration:'TEST',routeId:'10',from:'AAA',to:'GRU',
  status:'departed',reason:'NATIVE_INFLIGHT_IDENTITY_COUNTDOWN_AND_ONBOARD_CONFIRMED',
  demand:null,actualOnboard:{Y:90,J:0,F:0}
 };
 return {
  schemaVersion:1,dryRun:false,scope:'existing-route-ready-aircraft',
  generatedAt:new Date().toISOString(),completedAt:new Date().toISOString(),
  halted:false,summary:{evaluated:1,departed:1,simulated:0,held:0,unknown:0},
  entries:[entry]
 };
}
test('post-dispatch supply run requires a complete real flight cycle with confirmed departures',()=>{
 expect(postDispatchSupplyDecision(sample())).toEqual({allowed:true,reason:'DISPATCH_COMPLETED'});
 expect(postDispatchSupplyDecision(undefined).reason).toBe('DISPATCH_REPORT_UNVERIFIED');
 expect(postDispatchSupplyDecision({...sample(),dryRun:true}).reason).toBe('SIMULATION');
 expect(postDispatchSupplyDecision({...sample(),completedAt:null}).reason).toBe('DISPATCH_REPORT_UNVERIFIED');
 expect(postDispatchSupplyDecision({...sample(),halted:true,summary:{...sample().summary,unknown:1}}).reason).toBe('DEPARTURE_OUTCOME_UNKNOWN');
 const bad=sample();bad.entries[0].status='attempting';
 expect(postDispatchSupplyDecision(bad).reason).toBe('DEPARTURE_OUTCOME_UNKNOWN');
});
test('partial fleet due to runtime or manual cap blocks post-dispatch purchase',()=>{
 for(const reason of ['RUN_TIME_BUDGET_EXHAUSTED_BEFORE_EVALUATION',
  'RUN_TIME_BUDGET_EXHAUSTED_BEFORE_MUTATION','EXECUTION_LIMIT','INITIAL_COLLECTION_INCOMPLETE']){
  const r=sample();r.entries.push({...r.entries[0],aircraftId:'2',routeId:'11',status:'held',reason,actualOnboard:null});
  r.summary={evaluated:2,departed:1,simulated:0,held:1,unknown:0};
  expect(postDispatchSupplyDecision(r).reason).toBe('DISPATCH_INCOMPLETE');
 }
});
test('legitimate fuel and demand holds do not pretend all aircraft departed',()=>{
 const r=sample();r.entries.push({...r.entries[0],aircraftId:'2',routeId:'11',
  status:'held',reason:'FUEL_STOCK_INSUFFICIENT_BY_VERIFIED_HISTORY',actualOnboard:null});
 r.summary={evaluated:2,departed:1,simulated:0,held:1,unknown:0};
 expect(postDispatchSupplyDecision(r)).toMatchObject({allowed:true});
});
test('no confirmed flights means no second purchase trigger',()=>{
 const r=sample();r.entries[0]={...r.entries[0],status:'held',reason:'DEMAND_INSUFFICIENT',actualOnboard:null};
 r.summary={evaluated:1,departed:0,simulated:0,held:1,unknown:0};
 expect(postDispatchSupplyDecision(r).reason).toBe('NO_CONFIRMED_DEPARTURES');
});
