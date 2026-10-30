import {test,expect} from '@playwright/test';
import {IndividualDepartureExecutor,type DeparturePort,type ExecutionReport, type CurrentRouteFuelEvidence} from '../../demand/executor';
import {readDemandConfig} from '../../demand/config';
import {flightCountdownObservation} from '../../optimization/flight-timing';
import type {AircraftSnapshot,CollectionResult} from '../../demand/types';

const aircraft=(id:string,from='GRU',to='XAP'):AircraftSnapshot=>({
  aircraftId:id,routeId:String(Number(id)+1000),registration:'TEST-'+id,
  routeLabel:from+' - '+to,from,to,state:'ready',
  capacity:{Y:100,J:0,F:0},remaining:{Y:100,J:0,F:0},dailyTotal:{Y:200,J:0,F:0},
  observedAt:new Date().toISOString()
});
const native=(planes:AircraftSnapshot[],valid=true):CollectionResult=>({
  aircraft:planes,complete:false,expectedRoutes:132,warnings:valid?[]:['UNVERIFIED'],
  observationScope:valid?'native-individual-first-page':undefined,
  windowReadyCandidates:planes.length
});
const quote=(a:AircraftSnapshot):CurrentRouteFuelEvidence=>({
  aircraftId:a.aircraftId,routeId:a.routeId,from:a.from,to:a.to,
  fuelLbs:12000,observedAt:new Date().toISOString()
});
async function execute(args:{
  windows:CollectionResult[];fuel?:number;max?:number;
  unknown?:boolean;deadlineEpochMs?:number
}){
  let collects=0;let clicks=0;const transitions:ExecutionReport[]=[];
  const port:DeparturePort={
    collect:async()=>args.windows[Math.min(collects++,args.windows.length-1)],
    prepare:async a=>({...a,observedAt:new Date().toISOString()}),
    depart:async()=>{clicks++;if(args.unknown)throw Error('TIMEOUT');},
    confirm:async a=>({...a,state:'inflight',onboard:{Y:80,J:0,F:0},
      timing:flightCountdownObservation(a.aircraftId,a.routeId,'01:15:00',new Date().toISOString())})
  };
  const quotes=new Map(args.windows.flatMap(w=>w.aircraft.map(a=>[a.aircraftId,quote(a)] as const)));
  const report=await new IndividualDepartureExecutor(port,readDemandConfig({}),{
    rollingIndividualMode:true,dryRun:false,maxDepartures:args.max??8,
    campaignVerified:true,fuelHoldingLbsAtRunStart:args.fuel??40000,
    mutationDeadlineEpochMs:args.deadlineEpochMs,currentRouteFuelEvidence:quotes
  },async r=>{transitions.push(JSON.parse(JSON.stringify(r)));}).run();
  return {report,clicks,collects,transitions};
}
test('after the first confirmed flight, a newly visible first-page aircraft is safely dispatched',async()=>{
  const a=aircraft('2001'),b=aircraft('2002','XAP','DTW');
  const r=await execute({windows:[native([a]),native([b]),native([b])]});
  expect(r.report.summary).toMatchObject({departed:2,unknown:0});
  expect(r.clicks).toBe(2);
  expect(r.collects).toBe(3);
  expect(r.report.entries.map(e=>e.aircraftId)).toEqual(['2001','2002']);
  expect(r.transitions.filter(t=>t.entries.at(-1)?.status==='attempting').length).toBeGreaterThanOrEqual(2);
  expect(r.transitions.at(-1)?.completedAt).toBeTruthy();
});
test('a repeated card never triggers a second departure',async()=>{
  const a=aircraft('2001');
  const r=await execute({windows:[native([a]),native([a])]});
  expect(r.report.summary.departed).toBe(1);
  expect(r.clicks).toBe(1);
  expect(r.collects).toBe(2);
});
test('an unverified next window cannot authorize any additional click',async()=>{
  const a=aircraft('2001'),b=aircraft('2002','XAP','DTW');
  const r=await execute({windows:[native([a]),native([b],false)]});
  expect(r.report.summary.departed).toBe(1);
  expect(r.clicks).toBe(1);
  expect(r.collects).toBe(2);
});
test('conservative total Fuel limit persists across successive first-page refreshes',async()=>{
  const a=aircraft('2001'),b=aircraft('2002','XAP','DTW');
  const r=await execute({windows:[native([a]),native([b])],fuel:20000});
  expect(r.report.summary).toMatchObject({departed:1,unknown:0});
  expect(r.report.entries[1]?.reason).toBe('FUEL_STOCK_INSUFFICIENT_BY_VERIFIED_HISTORY');
  expect(r.clicks).toBe(1);
});
test('unknown outcome blocks rescans and never retries',async()=>{
  const a=aircraft('2001'),b=aircraft('2002','XAP','DTW');
  const r=await execute({windows:[native([a]),native([b])],unknown:true});
  expect(r.report.summary.unknown).toBe(1);
  expect(r.report.halted).toBe(true);
  expect(r.clicks).toBe(1);
  expect(r.collects).toBe(1);
});
test('max departures is enforced across repeated first-page refreshes',async()=>{
  const a=aircraft('2001'),b=aircraft('2002','XAP','DTW');
  const r=await execute({windows:[native([a]),native([b])],max:1});
  expect(r.clicks).toBe(1);
  expect(r.collects).toBe(1);
});
test('only confirmed flights may cause a new rolling pass',async()=>{
  const a=aircraft('2001'),b=aircraft('2002','XAP','DTW');
  const r=await execute({windows:[native([a]),native([b])],fuel:10000});
  expect(r.clicks).toBe(0);
  expect(r.collects).toBe(1);
});

test('demand pool reservations cannot be reset by a later page-one arrival',async()=>{
  const a=aircraft('2001','GRU','XAP'),b=aircraft('2002','XAP','GRU');
  const r=await execute({windows:[native([a]),native([b])],fuel:30000});
  expect(r.clicks).toBe(1);
  expect(r.report.summary).toMatchObject({departed:1,unknown:0});
  expect(r.report.entries[1]?.status).toBe('held');
  expect(r.collects).toBe(2);
});
test('a failed subsequent read does not erase the confirmed departure checkpoint',async()=>{
  const a=aircraft('2001');
  const completed:ExecutionReport[]=[];
  let reads=0,clicks=0;
  const port:DeparturePort={
    collect:async()=>{
      reads++;
      if(reads>1)throw Error('SYNTHETIC_NEXT_WINDOW_FAILURE');
      return native([a]);
    },
    prepare:async x=>({...x,observedAt:new Date().toISOString()}),
    depart:async()=>{clicks++;},
    confirm:async x=>({...x,state:'inflight',onboard:{Y:80,J:0,F:0},
      timing:flightCountdownObservation(x.aircraftId,x.routeId,'01:00:00',new Date().toISOString())})
  };
  await expect(new IndividualDepartureExecutor(port,readDemandConfig({}),{
    rollingIndividualMode:true,dryRun:false,maxDepartures:8,
    campaignVerified:true,fuelHoldingLbsAtRunStart:24000,
    currentRouteFuelEvidence:new Map([[a.aircraftId,quote(a)]])
  },async result=>{completed.push(JSON.parse(JSON.stringify(result)));}).run())
    .rejects.toThrow('ROLLING_NEXT_WINDOW_COLLECTION_FAILED');
  expect(clicks).toBe(1);
  expect(reads).toBe(2);
  expect(completed.at(-1)?.entries[0]?.status).toBe('departed');
  expect(completed.at(-1)?.halted).toBe(true);
});

test('first-page rolling dispatch continues across more than four verified batches without a global scan',async()=>{
  const planes=Array.from({length:7},(_,i)=>aircraft(String(3001+i),'GRU','XAP'));
  const windows=[...planes.map(a=>native([a])),native([planes.at(-1)!])];
  const r=await execute({windows,max:10,fuel:100000});
  expect(r.report.summary).toMatchObject({departed:7,unknown:0});
  expect(r.clicks).toBe(7);
  expect(r.collects).toBe(8);
  expect(r.report.entries.map(e=>e.aircraftId)).toEqual(planes.map(a=>a.aircraftId));
});
