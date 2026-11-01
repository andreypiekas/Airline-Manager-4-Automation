import {test,expect} from '@playwright/test';
import {verifiedPostDispatchShortTail} from '../../demand/rolling-tail-reconciliation';
import type {CollectionResult,AircraftSnapshot} from '../../demand/types';
import {IndividualDepartureExecutor,type DeparturePort} from '../../demand/executor';
import {readDemandConfig} from '../../demand/config';
import {flightCountdownObservation} from '../../optimization/flight-timing';

const card=(n:number,state:'ready'|'inflight'|'unavailable'='inflight')=>({
 aircraftId:String(2000+n),routeId:String(3000+n),registration:'PP-'+n,state
});
const aircraft=(n:number):AircraftSnapshot=>({
 ...card(n,'ready'),routeLabel:n===1?'GRU - XAP':'XAP - DTW',from:n===1?'GRU':'XAP',to:n===1?'XAP':'DTW',
 capacity:{Y:100,J:0,F:0},remaining:{Y:100,J:0,F:0},
 dailyTotal:{Y:200,J:0,F:0},observedAt:new Date().toISOString()
});
const baseline=(readyIds:number[]=[1,2]):CollectionResult=>({
 aircraft:readyIds.map(aircraft),complete:false,expectedRoutes:178,
 observationScope:'native-individual-first-page',
 windowReadyCandidates:readyIds.length,warnings:[],
 windowObservedAircraft:Array.from({length:20},(_,i)=>
   card(i+1,readyIds.includes(i+1)?'ready':'inflight'))
});
const shortTail=(ids:number[]):CollectionResult=>({
 aircraft:[],complete:false,expectedRoutes:178,windowReadyCandidates:0,
 windowShortNoReadyObserved:true,warnings:['ROLLING_WINDOW_UNVERIFIED'],
 windowObservedAircraft:ids.map(n=>card(n,'inflight'))
});
const fullIds=Array.from({length:20},(_,i)=>i+1);

test('production #1320/#1321: missing card is one of the confirmed departures',()=>{
 const before=baseline([1,2]);
 const after=shortTail(fullIds.filter(n=>n!==1));
 expect(verifiedPostDispatchShortTail(before,after,new Set(['2001:3001','2002:3002']))).toBe(true);
 expect(after.complete).toBe(false);
 expect(after.windowShortNoReadyObserved).toBe(true);
});

test('unknown, new, ambiguous, changed and unconfirmed cards stay unsafe',()=>{
 const before=baseline([1,2]);
 const valid=shortTail(fullIds.filter(n=>n!==1));
 const good=new Set(['2001:3001','2002:3002']);
 const mutations:CollectionResult[]=[
   {...valid,windowShortNoReadyObserved:false},
   {...valid,expectedRoutes:179},
   {...valid,warnings:[]},
   {...valid,windowObservedAircraft:valid.windowObservedAircraft?.map((a,i)=>i===0?{...a,registration:'OTHER'}:a)},
   {...valid,windowObservedAircraft:valid.windowObservedAircraft?.map((a,i)=>i===0?{...a,aircraftId:'99999'}:a)},
   {...valid,windowObservedAircraft:valid.windowObservedAircraft?.map((a,i)=>i===0?{...a,state:'ready' as const}:a)},
   {...valid,windowObservedAircraft:valid.windowObservedAircraft?.map((a,i)=>i===0?{...a,routeId:'99999'}:a)},
   {...valid,windowObservedAircraft:valid.windowObservedAircraft?.slice(1).concat(valid.windowObservedAircraft![1])},
   shortTail(fullIds.filter(n=>n!==3)),
   {...valid,aircraft:[aircraft(99)]}
 ];
 for(const after of mutations)
   expect(verifiedPostDispatchShortTail(before,after,good)).toBe(false);
 expect(verifiedPostDispatchShortTail(before,valid,new Set(['2002:3002']))).toBe(false);
 expect(verifiedPostDispatchShortTail({...before,windowObservedAircraft:before.windowObservedAircraft?.slice(1)},valid,good)).toBe(false);
 expect(verifiedPostDispatchShortTail({...before,windowReadyCandidates:3},valid,good)).toBe(false);
 // With no fresh native roster evidence, do not infer what disappeared.
 expect(verifiedPostDispatchShortTail(before,{...valid,windowObservedAircraft:undefined},good)).toBe(false);
});

test('confirmed two flights and reconciled short tail finish scoped success, no extra click',async()=>{
 const before=baseline([1,2]);
 const after=shortTail(fullIds.filter(n=>n!==1));
 let collects=0,departClicks=0;
 const port:DeparturePort={
  collect:async()=>++collects===1?before:after,
  prepare:async a=>({...a,observedAt:new Date().toISOString()}),
  depart:async()=>{departClicks++;},
  confirm:async a=>({...a,state:'inflight',onboard:{Y:80,J:0,F:0},
   timing:flightCountdownObservation(a.aircraftId,a.routeId,'01:00:00',new Date().toISOString())})
 };
 const quotes=new Map(before.aircraft.map(a=>[a.aircraftId,{
  aircraftId:a.aircraftId,routeId:a.routeId,from:a.from,to:a.to,
  fuelLbs:12000,observedAt:new Date().toISOString()}]));
 const report=await new IndividualDepartureExecutor(port,readDemandConfig({}),{
  rollingIndividualMode:true,dryRun:false,maxDepartures:'all',
  fuelHoldingLbsAtRunStart:150000,campaignVerified:true,currentRouteFuelEvidence:quotes
 },async()=>{}).run();
 expect(report.summary).toMatchObject({evaluated:2,departed:2,held:0,unknown:0});
 expect(report.postDispatchShortTailReconciled).toBe(true);
 expect(report.rollingWindowUnverified).not.toBe(true);
 expect(report.halted).toBe(false);
 expect(collects).toBe(2);
 expect(departClicks).toBe(2);
});
