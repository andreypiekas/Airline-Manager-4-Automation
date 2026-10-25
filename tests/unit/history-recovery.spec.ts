import { test,expect } from '@playwright/test';
import type { AircraftSnapshot,CollectionResult } from '../../demand/types';
import { validFreshHistoryRecovery,flightHistoryRecoveryRejectionReason,selectMissingFlightHistory,recoverMissingFlightHistories } from '../../demand/history-recovery';

const stamp=new Date().toISOString();
const aircraft=(id='101'):AircraftSnapshot=>({
  aircraftId:id,registration:'TEST-'+id,routeId:'900'+id,routeLabel:'GRU-LIM',
  from:'GRU',to:'LIM',state:'inflight',observedAt:stamp,
  capacity:{Y:100,J:10,F:2},remaining:{Y:160,J:25,F:5},dailyTotal:{Y:200,J:30,F:8},
  onboard:{Y:75,J:7,F:1},operational:{cycles:20,rangeKm:7000,minRunwayFt:6500} as any,
  flightHistory:{status:'unavailable',observedAt:stamp,source:'inspected-aircraft-flight-history',
    complete:false,entries:[],comparisonReady:false,mutationAuthorized:false}
});
const observed=(original:AircraftSnapshot):AircraftSnapshot=>({...original,
  flightHistory:{status:'observed',observedAt:new Date(Date.now()+50).toISOString(),
    source:'inspected-aircraft-flight-history',complete:false,entries:[{
      relativeTime:'1 hour ago',from:'LIM',to:'GRU',registrationLabel:original.registration,
      co2Quotas:100,onboard:{Y:50,J:5,F:1},fuelLbs:12000,revenue:80000
    }],comparisonReady:false,mutationAuthorized:false}
});
const collection=(a:AircraftSnapshot[]):CollectionResult=>({aircraft:a,complete:true,expectedRoutes:a.length,warnings:[]});

test('only isolated missing histories from a complete unique inventory are eligible',()=>{
  const present=observed(aircraft('201'));const missing=aircraft('202');
  expect(selectMissingFlightHistory(collection([present,missing])).map(a=>a.aircraftId)).toEqual(['202']);
  expect(selectMissingFlightHistory(collection([aircraft('1'),aircraft('2'),aircraft('3')]))).toEqual([]);
  expect(selectMissingFlightHistory({...collection([missing]),complete:false})).toEqual([]);
  expect(selectMissingFlightHistory(collection([missing,missing]))).toEqual([]);
  expect(selectMissingFlightHistory({...collection([missing]),expectedRoutes:2})).toEqual([]);
  expect(()=>selectMissingFlightHistory(collection([missing]),4)).toThrow('FLIGHT_HISTORY_RECOVERY_CONFIG_INVALID');
});
test('recovery accepts only same observed aircraft, direction, demand, capacity, flight and cycles',()=>{
  const expected=aircraft();
  const fresh=observed(expected);
  expect(validFreshHistoryRecovery(expected,fresh)).toBe(true);
  for(const other of [
    {...fresh,aircraftId:'111'},
    {...fresh,registration:'WRONG'},
    {...fresh,routeId:'902'},
    {...fresh,from:'LIM',to:'GRU'},
    {...fresh,state:'ready' as const},
    {...fresh,operational:{...fresh.operational!,cycles:21}},
    {...fresh,remaining:{...fresh.remaining!,Y:fresh.remaining!.Y-1}},
    {...fresh,dailyTotal:{...fresh.dailyTotal!,J:fresh.dailyTotal!.J-1}},
    {...fresh,onboard:{...fresh.onboard!,Y:fresh.onboard!.Y-1}},
    {...fresh,capacity:{...fresh.capacity!,Y:fresh.capacity!.Y+1}},
    {...fresh,flightHistory:{...fresh.flightHistory!,status:'unavailable' as const,entries:[]}},
    {...fresh,observedAt:new Date(Date.parse(expected.observedAt)-1000).toISOString()},
  ]) expect(validFreshHistoryRecovery(expected,other)).toBe(false);
});
test('no isolated missing history means zero navigation or mutation',async({page})=>{
  const c=collection([observed(aircraft())]);
  const r=await recoverMissingFlightHistories(page,c,1000);
  expect(r).toEqual({schemaVersion:1,attempted:0,recovered:0,candidates:0,
    uiRestored:true,warnings:[],readOnly:true,mutationAuthorized:false});
});
test('expired retry budget cannot initiate navigation',async({page})=>{
  const c=collection([aircraft()]);
  const r=await recoverMissingFlightHistories(page,c,1000,Date.now()+1000);
  expect(r).toMatchObject({attempted:0,recovered:0,candidates:1,
    warnings:['FLIGHT_HISTORY_RECOVERY_BUDGET_INSUFFICIENT'],mutationAuthorized:false});
  expect(c.aircraft[0].flightHistory?.status).toBe('unavailable');
});

test('recovery diagnostics identify reason without authorizing an unverified context',()=>{
  const base=aircraft(),good=observed(base);
  const cases:[AircraftSnapshot,string][]=[
    [{...good,flightHistory:{...good.flightHistory!,status:'unavailable',entries:[]}},'HISTORY_NOT_OBSERVED'],
    [{...good,aircraftId:'999'},'IDENTITY_OR_ROUTE_CHANGED'],
    [{...good,state:'ready'},'FLIGHT_STATE_CHANGED'],
    [{...good,operational:{...good.operational!,cycles:21}},'FLIGHT_CYCLE_UNVERIFIED'],
    [{...good,remaining:{...good.remaining!,Y:good.remaining!.Y-1}},'DEMAND_OR_CAPACITY_CHANGED'],
    [{...good,observedAt:new Date(Date.parse(base.observedAt)-1000).toISOString()},'TIMESTAMP_UNVERIFIED'],
  ];
  for(const [fresh,reason] of cases){
    expect(validFreshHistoryRecovery(base,fresh)).toBe(false);
    expect(flightHistoryRecoveryRejectionReason(base,fresh)).toBe(reason);
  }
  expect(validFreshHistoryRecovery(base,good)).toBe(true);
  expect(flightHistoryRecoveryRejectionReason(base,good)).toBe('OTHER_CONTEXT_UNVERIFIED');
});
