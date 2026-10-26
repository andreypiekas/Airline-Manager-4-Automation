import {test,expect} from '@playwright/test';
import {IndividualDepartureExecutor,type DeparturePort,type ExecutionReport} from '../../demand/executor';
import {readDemandConfig} from '../../demand/config';
import {flightCountdownObservation} from '../../optimization/flight-timing';
import type {AircraftSnapshot,CollectionResult} from '../../demand/types';

const ready=():AircraftSnapshot=>({
  aircraftId:'2001',routeId:'1001',registration:'PP-OFFLINE',routeLabel:'GRU - XAP',
  from:'GRU',to:'XAP',state:'ready',capacity:{Y:100,J:0,F:0},
  remaining:{Y:100,J:0,F:0},dailyTotal:{Y:200,J:0,F:0},
  observedAt:new Date().toISOString()
});
const window=(a:AircraftSnapshot[]=[ready()]):CollectionResult=>({
  complete:false,expectedRoutes:132,aircraft:a,observationScope:'native-individual-first-page',
  windowReadyCandidates:a.length,warnings:[]
});
async function run(options:{
  inventory?:CollectionResult;rolling?:boolean;fuel?:number;
  quote?:boolean;campaign?:boolean;changed?:boolean;clickFails?:boolean;
  confirmFails?:boolean
}={}){
  let clicks=0,prepares=0,confirms=0;const transitions:ExecutionReport[]=[];
  const p:DeparturePort={
    collect:async()=>options.inventory??window(),
    prepare:async a=>{prepares++;return options.changed?{...a,registration:'OTHER'}:ready();},
    depart:async()=>{clicks++;if(options.clickFails)throw Error('TIMEOUT');},
    confirm:async a=>{confirms++;return options.confirmFails?null:{
      ...a,state:'inflight',onboard:{Y:80,J:0,F:0},
      timing:flightCountdownObservation(a.aircraftId,a.routeId,'01:00:00',new Date().toISOString())
    };}
  };
  const sample=ready();
  const report=await new IndividualDepartureExecutor(p,readDemandConfig({}),{
    dryRun:false,maxDepartures:8,
    rollingIndividualMode:options.rolling??true,
    campaignVerified:options.campaign??true,
    fuelHoldingLbsAtRunStart:options.fuel,
    currentRouteFuelEvidence:options.quote===false?undefined:new Map([[
      sample.aircraftId,{aircraftId:sample.aircraftId,routeId:sample.routeId,
        from:sample.from,to:sample.to,fuelLbs:12000,observedAt:new Date().toISOString()}
    ]])
  },async r=>{transitions.push(JSON.parse(JSON.stringify(r)));}).run().catch(e=>{
    if(e instanceof Error&&e.message==='ROLLING_INDIVIDUAL_WINDOW_NO_VERIFIED_CANDIDATES')return null;
    throw e;
  });
  return {report,clicks,prepares,confirms,transitions};
}
test('single live identity scoped window may depart, without pretending global Fleet completeness',async()=>{
 const r=await run({fuel:25000});
 expect(r.report?.summary).toMatchObject({evaluated:1,departed:1,unknown:0});
 expect(r.clicks).toBe(1);
 expect(r.transitions.some(t=>t.entries[0]?.status==='attempting')).toBe(true);
 expect(r.transitions.at(-1)?.entries[0].reason).toBe('NATIVE_INFLIGHT_IDENTITY_COUNTDOWN_AND_ONBOARD_CONFIRMED');
});
test('same 1/132 collection is blocked unless individual mode explicitly enabled',async()=>{
 const r=await run({rolling:false,fuel:25000});
 expect(r.clicks).toBe(0);
 expect(r.report?.entries[0].reason).toBe('INITIAL_COLLECTION_INCOMPLETE');
});
test('missing or mismatched live individual provenance cannot allow any click',async()=>{
 for(const inventory of [
   {...window(),observationScope:undefined},
   {...window(),windowReadyCandidates:2},
   {...window(),aircraft:[{...ready(),aircraftId:'invalid'}]},
   {...window(),aircraft:[{...ready(),issue:'UNVERIFIED'}]}
 ] as CollectionResult[]){
   const r=await run({inventory,fuel:25000});
   expect(r.clicks).toBe(0);
   expect(r.report?.entries.every(e=>e.status==='held')).toBe(true);
 }
});
test('rolling mode holds when fuel balance or exact fuel requirement is unverified',async()=>{
 for(const opts of [{fuel:undefined},{fuel:25000,quote:false},{fuel:10000}]){
   const r=await run(opts);
   expect(r.clicks).toBe(0);
   expect(r.report?.summary.departed).toBe(0);
 }
});
test('rolling mode refuses campaign unverified and changed identity',async()=>{
 for(const opts of [{fuel:25000,campaign:false},{fuel:25000,changed:true}]){
   const r=await run(opts);
   expect(r.clicks).toBe(0);
   expect(r.report?.summary.departed).toBe(0);
 }
});
test('rolling mode never retries an uncertain native click or unconfirmed flight',async()=>{
 for(const opts of [{fuel:25000,clickFails:true},{fuel:25000,confirmFails:true}]){
   const r=await run(opts);
   expect(r.clicks).toBe(1);
   expect(r.report?.summary).toMatchObject({departed:0,unknown:1});
   expect(r.report?.halted).toBe(true);
 }
});
test('duplicate route identity across individual evidence is held before any click',async()=>{
 const same=ready(),second={...ready(),aircraftId:'2002'};
 const r=await run({inventory:window([same,second]),fuel:25000});
 expect(r.clicks).toBe(0);
 expect(r.report?.entries.every(e=>e.reason==='INITIAL_IDENTITY_OR_ROUTE_DUPLICATE')).toBe(true);
});
