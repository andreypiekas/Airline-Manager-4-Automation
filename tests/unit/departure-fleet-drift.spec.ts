import {test,expect} from '@playwright/test';
import {IndividualDepartureExecutor,verifiedFleetDriftRefresh,type DeparturePort} from '../../demand/executor';
import {readDemandConfig} from '../../demand/config';
import {flightCountdownObservation} from '../../optimization/flight-timing';
import type {AircraftSnapshot,CollectionResult} from '../../demand/types';

const ready=(aircraftId:string,routeId:string,from:string):AircraftSnapshot=>({
  aircraftId,routeId,registration:'PP-'+aircraftId,routeLabel:from+' - GRU',
  from,to:'GRU',state:'ready',
  capacity:{Y:100,J:0,F:0},remaining:{Y:100,J:0,F:0},
  dailyTotal:{Y:300,J:0,F:0},observedAt:new Date().toISOString()
});
const a=()=>ready('1001','2001','AAA');
const b=()=>ready('1002','2002','BBB');
const c=()=>ready('1003','2003','CCC');
const full=(aircraft:AircraftSnapshot[]):CollectionResult=>({
  aircraft,complete:true,expectedRoutes:aircraft.length,warnings:[]
});

test('Fleet drift evidence requires a complete, unique global inventory and unchanged exact ready target',()=>{
  const expected=b(),good=full([a(),expected,c()]);
  expect(verifiedFleetDriftRefresh(good,expected)).toBe(true);
  expect(verifiedFleetDriftRefresh({...good,complete:false},expected)).toBe(false);
  expect(verifiedFleetDriftRefresh({...good,expectedRoutes:4},expected)).toBe(false);
  expect(verifiedFleetDriftRefresh(full([a(),expected,{...c(),aircraftId:expected.aircraftId}]),expected)).toBe(false);
  expect(verifiedFleetDriftRefresh(full([a(),expected,{...c(),routeId:expected.routeId}]),expected)).toBe(false);
  expect(verifiedFleetDriftRefresh(full([a(),{...expected,from:'CCC'},c()]),expected)).toBe(false);
  expect(verifiedFleetDriftRefresh(full([a(),{...expected,capacity:{Y:101,J:0,F:0}},c()]),expected)).toBe(false);
  expect(verifiedFleetDriftRefresh(full([a(),{...expected,state:'inflight'},c()]),expected)).toBe(false);
  expect(verifiedFleetDriftRefresh(full([a(),expected,{...c(),state:'ready',issue:'unknown'}]),expected)).toBe(false);
});

async function runDrift(options:{
  refreshed?:CollectionResult;firstTargetDrift?:boolean;repeatDrift?:boolean;
  mutationDeadlineEpochMs?:number
}={}){
  let collects=0,prepares=0,clicks=0,failures=0;
  const initial=full([a(),b()]);
  const refreshed=options.refreshed??full([a(),b(),c()]);
  const port:DeparturePort={
    collect:async()=>{collects++;return collects===1?initial:refreshed;},
    prepare:async target=>{
      prepares++;
      if(target.aircraftId===(options.firstTargetDrift?'1001':'1002')&&
         (failures===0||options.repeatDrift)){
        failures++;throw Error('DEPARTURE_FLEET_COUNT_CHANGED');
      }
      return {...target,observedAt:new Date().toISOString()};
    },
    depart:async()=>{clicks++;},
    confirm:async target=>({...target,state:'inflight',onboard:{Y:80,J:0,F:0},
      timing:flightCountdownObservation(target.aircraftId,target.routeId,'01:00:00',new Date().toISOString())})
  };
  const report=await new IndividualDepartureExecutor(port,readDemandConfig({}),{
    dryRun:false,maxDepartures:'all',campaignVerified:true,
    mutationDeadlineEpochMs:options.mutationDeadlineEpochMs
  },async()=>{}).run();
  return {report,collects,prepares,clicks};
}

test('one native Fleet count change triggers one read-only full rescan and fresh per-target prepare',async()=>{
  const result=await runDrift();
  expect(result.collects).toBe(2);
  expect(result.prepares).toBe(3);
  expect(result.clicks).toBe(2);
  expect(result.report.summary).toMatchObject({evaluated:2,departed:2,held:0,unknown:0});
  expect(result.report.entries.every(e=>e.reason==='NATIVE_INFLIGHT_IDENTITY_COUNTDOWN_AND_ONBOARD_CONFIRMED')).toBe(true);
});

for(const [name,refreshed] of [
  ['incomplete global scan',{...full([a(),b(),c()]),complete:false}],
  ['route count mismatch',{...full([a(),b(),c()]),expectedRoutes:4}],
  ['duplicate route ID',full([a(),b(),{...c(),routeId:b().routeId}])],
  ['changed target direction',full([a(),{...b(),from:'CCC'},c()])],
  ['changed target capacity',full([a(),{...b(),capacity:{Y:101,J:0,F:0}},c()])]
] as const){
  test('drift remains HOLD without second click: '+name,async()=>{
    const result=await runDrift({refreshed});
    expect(result.collects).toBe(2);
    expect(result.clicks).toBe(1);
    expect(result.report.summary).toMatchObject({departed:1,held:1,unknown:0});
    expect(result.report.entries[1]).toMatchObject({
      status:'held',reason:'DEPARTURE_CONTROL_OR_FRESH_DETAILS_UNVERIFIED',
      prepareFailureCode:'DEPARTURE_FLEET_COUNT_CHANGED'
    });
  });
}
test('drift on first target with unverified refreshed fleet never clicks',async()=>{
  const result=await runDrift({firstTargetDrift:true,refreshed:{...full([a(),b(),c()]),complete:false}});
  expect(result.clicks).toBe(0);
  expect(result.report.entries[0].status).toBe('held');
  expect(result.report.entries[1]).toMatchObject({
    status:'held',reason:'FLEET_DRIFT_UNRECONCILED'
  });
});
test('repeated count drift is not repeatedly rescanned and cannot cause an uncertain click',async()=>{
  const result=await runDrift({repeatDrift:true});
  expect(result.collects).toBe(2);
  expect(result.clicks).toBe(1);
  expect(result.report.summary).toMatchObject({departed:1,held:1,unknown:0});
  expect(result.report.entries[1].prepareFailureCode).toBe('DEPARTURE_FLEET_COUNT_CHANGED');
});
