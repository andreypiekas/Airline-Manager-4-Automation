import {test,expect} from '@playwright/test';
import {hasAllReadyDepartureDetailsUnverified} from '../../demand/execute-run';
import type {ExecutionEntry,ExecutionReport} from '../../demand/executor';

// Real #1075: complete identity inventory (161/161), but 11/11 ready
// aircraft timed out on details. No demand was verified and no click occurred.
const unavailable=(id:number):ExecutionEntry=>({
  aircraftId:String(id),registration:'PP-'+id,routeId:String(1000+id),
  from:'ASB',to:'TAG',status:'held',
  reason:'DEPARTURE_CONTROL_OR_FRESH_DETAILS_UNVERIFIED',
  demand:null,actualOnboard:null,prepareFailureCode:'UNCLASSIFIED'
});
const report=(entries:ExecutionEntry[],departed=0):Pick<ExecutionReport,'entries'|'summary'>=>({
  entries,summary:{evaluated:entries.length,departed,held:entries.filter(e=>e.status==='held').length,
    simulated:0,unknown:0}
});

test('run #1075: all 11 ready aircraft details timed out, zero departures must not be green',()=>{
  const held=Array.from({length:11},(_,i)=>unavailable(i+1));
  expect(hasAllReadyDepartureDetailsUnverified(report(held))).toBe(true);
});

test('no-ready, verified demand holds, or partial confirmed dispatch are not misclassified',()=>{
  const held=unavailable(1);
  expect(hasAllReadyDepartureDetailsUnverified(report([]))).toBe(false);
  expect(hasAllReadyDepartureDetailsUnverified(report([{
    ...held,reason:'DEMAND_INSUFFICIENT'
  }]))).toBe(false);
  expect(hasAllReadyDepartureDetailsUnverified(report([{
    ...held,reason:'FUEL_STOCK_INSUFFICIENT_BY_VERIFIED_HISTORY'
  }]))).toBe(false);
  expect(hasAllReadyDepartureDetailsUnverified(report([held],1))).toBe(false);
  expect(hasAllReadyDepartureDetailsUnverified(report([held,{
    ...unavailable(2),reason:'DEMAND_INSUFFICIENT'
  }]))).toBe(false);
});

test('unclassified preflight failure requires absent demand evidence, never inferred eligibility',()=>{
  expect(hasAllReadyDepartureDetailsUnverified(report([{
    ...unavailable(1),prepareFailureCode:'DEPARTURE_FLEET_COUNT_CHANGED'
  }]))).toBe(false);
  expect(hasAllReadyDepartureDetailsUnverified(report([{
    ...unavailable(1),demand:{decision:'hold_insufficient'} as ExecutionEntry['demand']
  }]))).toBe(false);
});
