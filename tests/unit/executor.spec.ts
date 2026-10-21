import { test,expect } from '@playwright/test';
import { IndividualDepartureExecutor, DeparturePort, ExecutionReport } from '../../demand/executor';
import { AircraftSnapshot, CollectionResult } from '../../demand/types';
import { readDemandConfig } from '../../demand/config';
import { flightCountdownObservation } from '../../optimization/flight-timing';
import { departureControlShape } from '../../demand/departure-control-evidence';
import { hasIncompleteInitialDepartureCollection } from '../../demand/execute-run';

const snapshot=(change:Partial<AircraftSnapshot>={}):AircraftSnapshot=>({aircraftId:'1',registration:'TEST',routeId:'10',routeLabel:'AAA - GRU',from:'AAA',to:'GRU',state:'ready',capacity:{Y:100,J:0,F:0},remaining:{Y:100,J:0,F:0},dailyTotal:{Y:1000,J:100,F:100},observedAt:new Date().toISOString(),...change});
const collection=(a:AircraftSnapshot[]=[snapshot()],complete=true):CollectionResult=>({aircraft:a,complete,expectedRoutes:a.length,warnings:[]});
function setup(options:{initial?:CollectionResult;fresh?:CollectionResult;prepared?:AircraftSnapshot;confirmed?:AircraftSnapshot|null;dryRun?:boolean;limit?:number|'all';prepareFail?:boolean;clickFail?:boolean;collectFail?:boolean;saveFail?:boolean;mutationDeadlineEpochMs?:number;blockedDepartureKeys?:ReadonlySet<string>;fuelHoldingLbsAtRunStart?:number;campaignVerified?:boolean;postReroutePricingBlockedAircraftIds?:ReadonlySet<string>;currentRouteFuelEvidence?:ReadonlyMap<string,{aircraftId:string;routeId:string;from:string;to:string;fuelLbs:number;observedAt:string}>}={}) {
  let reads=0,clicks=0;const saved:ExecutionReport[]=[];
  const port:DeparturePort={collect:async()=>{reads++;if(options.collectFail)throw Error('loading');return options.initial??collection([snapshot()]);},
    prepare:async a=>{if(options.prepareFail)throw Error('unverified');return options.prepared??snapshot(a);},
    depart:async()=>{clicks++;if(options.clickFail)throw Error('timeout');},
    confirm:async a=>options.confirmed===null?null:options.confirmed??snapshot({...a,state:'inflight',onboard:{Y:88,J:0,F:0},timing:flightCountdownObservation(a.aircraftId,a.routeId,'01:00:00',new Date().toISOString())})};
  const executor=new IndividualDepartureExecutor(port,readDemandConfig({}),{dryRun:options.dryRun??false,maxDepartures:options.limit??1,mutationDeadlineEpochMs:options.mutationDeadlineEpochMs,blockedDepartureKeys:options.blockedDepartureKeys,fuelHoldingLbsAtRunStart:options.fuelHoldingLbsAtRunStart,campaignVerified:options.campaignVerified,postReroutePricingBlockedAircraftIds:options.postReroutePricingBlockedAircraftIds,currentRouteFuelEvidence:options.currentRouteFuelEvidence},async r=>{if(options.saveFail&&r.entries.some(e=>e.status==='attempting'))throw Error('disk');saved.push(JSON.parse(JSON.stringify(r)));});
  return {executor,saved,clicks:()=>clicks,reads:()=>reads};
}
test('persist intent before exactly one native click and confirm onboard separately from demand coverage',async()=>{
 const s=setup();const r=await s.executor.run();expect(s.clicks()).toBe(1);expect(s.saved.some(r=>r.entries[0]?.status==='attempting')).toBe(true);
 expect(r.summary).toMatchObject({departed:1,unknown:0});expect(r.entries[0].demand?.occupancyPercentage).toBe(100);expect(r.entries[0].actualOnboard?.Y).toBe(88);
 await expect(s.executor.run()).rejects.toThrow('EXECUTION_ALREADY_USED');expect(s.clicks()).toBe(1);
});

test('confirmed departure records a gross fare estimate without using it for authorization',async()=>{
 const live=snapshot({fares:{source:'inspected-auto-control',automatic:{Y:110,J:0,F:0},current:{Y:120,J:0,F:0}}});
 const s=setup({prepared:live});
 const r=await s.executor.run();
 expect(s.clicks()).toBe(1);
 expect(r.entries[0].status).toBe('departed');
 expect(r.entries[0].estimatedGrossTicketRevenue).toBe(88*120);
 expect(s.saved.find(x=>x.entries[0]?.status==='attempting')?.entries[0].estimatedGrossTicketRevenue).toBeUndefined();
});

test('same airport route on separate route/aircraft IDs is not a duplicate identity blocker',async()=>{
 const sharedDemand={Y:200,J:0,F:0};
 const list=[snapshot({aircraftId:'1',routeId:'10',registration:'ONE',remaining:sharedDemand}),
 snapshot({aircraftId:'2',routeId:'11',registration:'TWO',remaining:sharedDemand})];
 const s=setup({initial:collection(list),limit:2});
 const r=await s.executor.run();
 expect(s.clicks()).toBe(2);
 expect(r.summary.departed).toBe(2);
 expect(r.entries.every(x=>x.reason!=='INITIAL_IDENTITY_OR_ROUTE_DUPLICATE')).toBe(true);
});
test('simulation uses same checks and never calls depart',async()=>{const s=setup({dryRun:true});expect((await s.executor.run()).summary.simulated).toBe(1);expect(s.clicks()).toBe(0);});
test('aircraft at its own base departs on the existing route when demand is sufficient',async()=>{
 const atBase=snapshot({from:'GRU',to:'AAA',routeLabel:'GRU - AAA'});
 const s=setup({initial:collection([atBase]),fresh:collection([atBase]),prepared:atBase});
 const r=await s.executor.run();
 expect(s.clicks()).toBe(1);
 expect(r.summary).toMatchObject({departed:1,held:0});
 expect(r.entries[0].from).toBe('GRU');
 expect(r.entries[0].to).toBe('AAA');
});
test('existing route departs from any airport even when neither endpoint is an airline hub',async()=>{
 const anywhere=snapshot({from:'AAA',to:'BBB',routeLabel:'AAA - BBB'});
 const s=setup({initial:collection([anywhere]),prepared:anywhere});
 const r=await s.executor.run();
 expect(s.clicks()).toBe(1);
 expect(r.summary).toMatchObject({departed:1,held:0});
 expect(r.entries[0]).toMatchObject({from:'AAA',to:'BBB',status:'departed'});
});
for(const [name,options] of Object.entries({
 'zero demand':{prepared:snapshot({remaining:{Y:0,J:0,F:0}})},
 'partial demand':{prepared:snapshot({remaining:{Y:79,J:0,F:0}})},
 'stale fresh demand':{prepared:snapshot({observedAt:'2020-01-01T00:00:00Z'})},
 'invalid demand':{prepared:snapshot({remaining:{Y:2000,J:0,F:0}})},
 'layout changed':{prepared:snapshot({capacity:{Y:101,J:0,F:0}})},
 'identity changed':{prepared:snapshot({aircraftId:'2'})},
 'incomplete initial collection':{initial:collection([snapshot()],false)},
 'duplicate aircraft':{initial:collection([snapshot(),snapshot({routeId:'11'})]),fresh:collection([snapshot(),snapshot({routeId:'11'})])},
 'duplicate route':{initial:collection([snapshot(),snapshot({aircraftId:'2'})]),fresh:collection([snapshot(),snapshot({aircraftId:'2'})])},
 'control not verified':{prepareFail:true},
})) test(`holds without clicks: ${name}`,async()=>{const s=setup(options);const r=await s.executor.run();expect(r.summary.departed).toBe(0);expect(r.summary.held).toBeGreaterThan(0);expect(s.clicks()).toBe(0);});
test('incomplete second fleet collection must fail the operational run rather than appear green',async()=>{
  const blocked=setup({initial:collection([snapshot()],false)});
  const report=await blocked.executor.run();
  expect(report.summary).toMatchObject({evaluated:1,departed:0,held:1,unknown:0});
  expect(report.entries[0].reason).toBe('INITIAL_COLLECTION_INCOMPLETE');
  expect(hasIncompleteInitialDepartureCollection(report)).toBe(true);
  expect(blocked.clicks()).toBe(0);
  const benign=setup({initial:collection([snapshot({state:'inflight'})])});
  expect(hasIncompleteInitialDepartureCollection(await benign.executor.run())).toBe(false);
});
for(const [index,options] of [{clickFail:true},{confirmed:null},{confirmed:snapshot({state:'ready'})},{confirmed:snapshot({state:'inflight',timing:null})}].entries())
 test(`unknown result stops without retry case ${index}`,async()=>{const s=setup(options);const r=await s.executor.run();expect(r.halted).toBe(true);expect(r.summary.unknown).toBe(1);expect(s.clicks()).toBe(1);});
test('persistence failure stops before operation',async()=>{const s=setup({saveFail:true});await expect(s.executor.run()).rejects.toThrow('disk');expect(s.clicks()).toBe(0);});
test('deferred priority is stable, identity-scoped, and does not override new demand',async()=>{
 const one=snapshot({aircraftId:'1',routeId:'10',from:'AAA',to:'GRU',registration:'ONE'});
 const two=snapshot({aircraftId:'2',routeId:'11',from:'BBB',to:'GRU',registration:'TWO',remaining:{Y:0,J:0,F:0}});
 const three=snapshot({aircraftId:'3',routeId:'12',from:'CCC',to:'GRU',registration:'THREE'});
 const list=collection([one,two,three]);
 const seen:string[]=[];
 const port:DeparturePort={
  collect:async()=>list,
  prepare:async a=>{seen.push(a.aircraftId);return a;},
  depart:async()=>{throw Error('must never click in simulation');},
  confirm:async()=>null
 };
 const report=await new IndividualDepartureExecutor(
  port,readDemandConfig({}),{dryRun:true,maxDepartures:1,prioritizedDepartureKeys:new Set(['2:11'])},async()=>{}
 ).run();
 expect(report.entries.map(e=>e.aircraftId)).toEqual(['2','1','3']);
 expect(seen).toEqual(['2','1']);
 expect(report.entries[0].status).toBe('held');
 expect(report.entries[0].demand?.decision).toBe('hold_insufficient');
 expect(report.entries[1].status).toBe('would_depart');
 expect(report.entries[2].reason).toBe('EXECUTION_LIMIT');
});

test('stale deferred queue identity never affects fresh fleet ordering',async()=>{
 const list=collection([snapshot(),snapshot({aircraftId:'2',routeId:'11',from:'BBB',to:'GRU',registration:'TWO'})]);
 const port:DeparturePort={
  collect:async()=>list,prepare:async a=>a,
  depart:async()=>{},confirm:async a=>snapshot({...a,state:'inflight'})
 };
 const report=await new IndividualDepartureExecutor(
  port,readDemandConfig({}),{dryRun:true,maxDepartures:1,prioritizedDepartureKeys:new Set(['2:10'])},async()=>{}
 ).run();
 expect(report.entries[0].aircraftId).toBe('1');
 expect(report.entries[0].status).toBe('would_depart');
});
test('all mode evaluates and dispatches all eligible aircraft, not a fixed numeric quota',async()=>{
 const list=['AAA','BBB','CCC'].map((from,index)=>snapshot({
   aircraftId:String(index+1),routeId:String(index+10),registration:'TEST-'+(index+1),
   from,to:'GRU',routeLabel:from+' - GRU'
 }));
 const s=setup({initial:collection(list),limit:'all'});
 const r=await s.executor.run();
 expect(s.clicks()).toBe(3);
 expect(r.summary).toMatchObject({evaluated:3,departed:3,held:0,unknown:0});
 expect(r.entries.some(e=>e.reason==='EXECUTION_LIMIT')).toBe(false);
});
test('real departure cap prevents additional attempts',async()=>{const list=[snapshot(),snapshot({aircraftId:'2',routeId:'11'})];const s=setup({initial:collection(list),fresh:collection(list)});const r=await s.executor.run();expect(s.clicks()).toBe(1);expect(r.entries[1].reason).toBe('EXECUTION_LIMIT');});
test('multiple aircraft use one complete fleet snapshot and targeted fresh reads',async()=>{
 const list=[snapshot(),snapshot({aircraftId:'2',routeId:'11',from:'BBB',to:'GRU',routeLabel:'BBB - GRU'})];
 const s=setup({initial:collection(list),limit:2});
 const r=await s.executor.run();
 expect(s.reads()).toBe(1);
 expect(s.clicks()).toBe(2);
 expect(r.summary).toMatchObject({departed:2,held:0,unknown:0});
});
test('initial fleet collection failure aborts before any mutation',async()=>{
 const s=setup({collectFail:true});
 await expect(s.executor.run()).rejects.toThrow('EXECUTION_INITIAL_COLLECTION_FAILED');
 expect(s.clicks()).toBe(0);
});
test('shared route capacity is allocated once, not twice',async()=>{const list=[snapshot(),snapshot({aircraftId:'2',routeId:'11',capacity:{Y:50,J:0,F:0}})];const s=setup({dryRun:true,limit:2,initial:collection(list),fresh:collection(list)});const r=await s.executor.run();expect(r.summary.simulated).toBe(1);expect(r.summary.held).toBe(1);expect(s.clicks()).toBe(0);});
test('handler evidence redacts every unrecognized query value',()=>{const shape=departureControlShape("Ajax('route_depart.php?id=123&token=PRIVATE&ref=details&costIndex=0','dummy',this);");expect(shape).not.toContain('PRIVATE');expect(shape).not.toContain('123');expect(shape).toContain('token=<value>');});

test('simulation obeys the same cap as real execution',async()=>{const list=[snapshot(),snapshot({aircraftId:'2',routeId:'11'})];const s=setup({dryRun:true,limit:1,initial:collection(list),fresh:collection(list)});const r=await s.executor.run();expect(r.summary.simulated).toBe(1);expect(r.entries[1].reason).toBe('EXECUTION_LIMIT');expect(s.clicks()).toBe(0);});
test('invalid onboard counts cannot confirm a departure',async()=>{const after=snapshot({state:'inflight',onboard:{Y:101,J:0,F:0},timing:flightCountdownObservation('1','10','01:00:00',new Date().toISOString())});const s=setup({confirmed:after});const r=await s.executor.run();expect(r.halted).toBe(true);expect(s.clicks()).toBe(1);});
test('countdown belonging to a different aircraft cannot confirm departure',async()=>{const after=snapshot({state:'inflight',onboard:{Y:88,J:0,F:0},timing:flightCountdownObservation('2','10','01:00:00',new Date().toISOString())});const s=setup({confirmed:after});const r=await s.executor.run();expect(r.summary.unknown).toBe(1);});


test('run time budget holds before mutation and never creates an uncertain result',async()=>{
 const s=setup({mutationDeadlineEpochMs:Date.now()-1});const r=await s.executor.run();
 expect(s.clicks()).toBe(0);expect(r.halted).toBe(false);expect(r.summary).toMatchObject({departed:0,unknown:0,held:1});expect(r.entries[0].reason).toBe('RUN_TIME_BUDGET_EXHAUSTED_BEFORE_EVALUATION');
});


test('persisted uncertain departure quarantine blocks before any click',async()=>{const s=setup({blockedDepartureKeys:new Set(['1:10'])});const r=await s.executor.run();expect(s.clicks()).toBe(0);expect(r.entries[0].reason).toBe('PERSISTED_UNCERTAIN_DEPARTURE_BLOCK');expect(r.summary).toMatchObject({held:1,unknown:0});});

test('freshly rerouted aircraft is held until pricing on the new route is verified',async()=>{
 const s=setup({postReroutePricingBlockedAircraftIds:new Set(['1'])});
 const r=await s.executor.run();
 expect(s.clicks()).toBe(0);
 expect(r.entries[0]).toMatchObject({status:'held',reason:'REROUTE_PRICING_NOT_VERIFIED'});
});

test('unverified required campaigns hold departures before fresh target reads or clicks',async()=>{
 const s=setup({campaignVerified:false});
 const r=await s.executor.run();
 expect(s.clicks()).toBe(0);
 expect(s.reads()).toBe(1);
 expect(r.summary).toMatchObject({departed:0,held:1,unknown:0});
 expect(r.entries[0]).toMatchObject({status:'held',reason:'CAMPAIGN_NOT_VERIFIED'});
});



test('two identical verified fuel observations are enough for a conservative route requirement',async()=>{
 const history={status:'observed' as const,observedAt:new Date().toISOString(),source:'inspected-aircraft-flight-history' as const,complete:false as const,comparisonReady:false as const,mutationAuthorized:false as const,entries:[
  {relativeTime:'6 hours ago',from:'TXL',to:'GRU',registrationLabel:'TEST',co2Quotas:100,onboard:{Y:80,J:0,F:0},fuelLbs:126220,revenue:1000},
  {relativeTime:'12 hours ago',from:'GRU',to:'TXL',registrationLabel:'TEST',co2Quotas:100,onboard:{Y:80,J:0,F:0},fuelLbs:126220,revenue:1000}
 ]};
 const a=snapshot({from:'GRU',to:'TXL',routeLabel:'GRU - TXL',flightHistory:history});
 const s=setup({initial:collection([a]),prepared:a,fuelHoldingLbsAtRunStart:500000});
 const r=await s.executor.run();
 expect(s.clicks()).toBe(1);
 expect(r.entries[0]).toMatchObject({status:'departed',resourceEvidence:{verifiedRouteFuelLbs:126220,matchingHistorySamples:2,trackingComplete:true}});
});

test('fresh verified current-route quote prevents cold-route fuel deadlock without guessing consumption',async()=>{
 const initial=collection();
 const aircraft=initial.aircraft[0];
 aircraft.flightHistory={status:'observed',observedAt:new Date().toISOString(),source:'inspected-aircraft-flight-history',complete:false,
  entries:[],comparisonReady:false,mutationAuthorized:false};
 const fresh={...aircraft,observedAt:new Date().toISOString()};
 const evidence=new Map([[aircraft.aircraftId,{
  aircraftId:aircraft.aircraftId,routeId:aircraft.routeId,from:aircraft.from,to:aircraft.to,
  fuelLbs:12345,observedAt:new Date().toISOString()
 }]]);
 const s=setup({initial,prepared:fresh,fuelHoldingLbsAtRunStart:50000,currentRouteFuelEvidence:evidence});
 const r=await s.executor.run();
 expect(s.clicks()).toBe(1);
 expect(r.entries[0].resourceEvidence).toMatchObject({
  verifiedRouteFuelLbs:12345,matchingHistorySamples:0,fuelEvidenceSource:'current-route-quote'
 });
 expect(r.entries[0].status).toBe('departed');
});

test('stale or mismatched current-route fuel quote never bypasses fuel verification',async()=>{
 const initial=collection(),aircraft=initial.aircraft[0];
 aircraft.flightHistory={status:'observed',observedAt:new Date().toISOString(),source:'inspected-aircraft-flight-history',complete:false,
  entries:[],comparisonReady:false,mutationAuthorized:false};
 const stale=new Map([[aircraft.aircraftId,{
  aircraftId:aircraft.aircraftId,routeId:aircraft.routeId,from:aircraft.from,to:aircraft.to,
  fuelLbs:12345,observedAt:new Date(Date.now()-3600_000).toISOString()
 }]]);
 const s=setup({initial,prepared:{...aircraft,observedAt:new Date().toISOString()},fuelHoldingLbsAtRunStart:50000,currentRouteFuelEvidence:stale});
 const r=await s.executor.run();
 expect(s.clicks()).toBe(0);
 expect(r.entries[0]).toMatchObject({status:'held',reason:'FUEL_REQUIREMENT_UNVERIFIED'});
});

test('verified historical fuel evidence blocks a departure before the click when run stock is insufficient',async()=>{
 const history=(fuelLbs:number)=>({status:'observed' as const,observedAt:new Date().toISOString(),source:'inspected-aircraft-flight-history' as const,complete:false as const,comparisonReady:false as const,mutationAuthorized:false as const,entries:[0,1,2].map(i=>({relativeTime:`${i+1} hours ago`,from:i%2?'GRU':'AAA',to:i%2?'AAA':'GRU',registrationLabel:'TEST',co2Quotas:100,onboard:{Y:80,J:0,F:0},fuelLbs,revenue:1000}))});
 const a=snapshot({flightHistory:history(59928)});
 const s=setup({initial:collection([a]),fresh:collection([a]),prepared:a,fuelHoldingLbsAtRunStart:20040});
 const r=await s.executor.run();
 expect(s.clicks()).toBe(0);
 expect(r.entries[0]).toMatchObject({status:'held',reason:'FUEL_STOCK_INSUFFICIENT_BY_VERIFIED_HISTORY',resourceEvidence:{fuelAvailableBefore:20040,verifiedRouteFuelLbs:59928,matchingHistorySamples:3,trackingComplete:true}});
});

test('confirmed departures debit only uniquely verified historical fuel and protect later aircraft',async()=>{
 const history=(from:string,to:string,fuelLbs:number)=>({status:'observed' as const,observedAt:new Date().toISOString(),source:'inspected-aircraft-flight-history' as const,complete:false as const,comparisonReady:false as const,mutationAuthorized:false as const,entries:[0,1,2].map(i=>({relativeTime:`${i+1} hours ago`,from:i%2?to:from,to:i%2?from:to,registrationLabel:'TEST',co2Quotas:100,onboard:{Y:80,J:0,F:0},fuelLbs,revenue:1000}))});
 const one=snapshot({flightHistory:history('AAA','GRU',9781)});
 const two=snapshot({aircraftId:'2',routeId:'11',from:'BBB',to:'GRU',routeLabel:'BBB - GRU',flightHistory:history('BBB','GRU',59928)});
 const list=collection([one,two]);let reads=0,clicks=0;
 const port:DeparturePort={
  collect:async()=>{reads++;return list;},
  prepare:async a=>a.aircraftId==='1'?one:two,
  depart:async()=>{clicks++;},
  confirm:async a=>snapshot({...a,state:'inflight',onboard:{Y:80,J:0,F:0},timing:flightCountdownObservation(a.aircraftId,a.routeId,'01:00:00',new Date().toISOString())})
 };
 const executor=new IndividualDepartureExecutor(port,readDemandConfig({}),{dryRun:false,maxDepartures:2,fuelHoldingLbsAtRunStart:29821},async()=>{});
 const r=await executor.run();
 expect(clicks).toBe(1);
 expect(r.entries[0].status).toBe('departed');
 expect(r.entries[1]).toMatchObject({status:'held',reason:'FUEL_STOCK_INSUFFICIENT_BY_VERIFIED_HISTORY',resourceEvidence:{fuelCommittedBefore:9781,fuelAvailableBefore:20040,verifiedRouteFuelLbs:59928}});
});

test('aircraft without verified fuel requirement is held without poisoning later verified departures',async()=>{
 const history=(from:string,to:string,fuelLbs:number)=>({status:'observed' as const,observedAt:new Date().toISOString(),source:'inspected-aircraft-flight-history' as const,complete:false as const,comparisonReady:false as const,mutationAuthorized:false as const,entries:[0,1,2].map(i=>({relativeTime:`${i+1} hours ago`,from:i%2?to:from,to:i%2?from:to,registrationLabel:'TEST',co2Quotas:100,onboard:{Y:80,J:0,F:0},fuelLbs,revenue:1000}))});
 const one=snapshot();
 const two=snapshot({aircraftId:'2',routeId:'11',from:'BBB',to:'GRU',routeLabel:'BBB - GRU',flightHistory:history('BBB','GRU',20000)});
 const list=collection([one,two]);let clicks=0;
 const port:DeparturePort={collect:async()=>list,prepare:async a=>a.aircraftId==='1'?one:two,depart:async()=>{clicks++;},confirm:async a=>snapshot({...a,state:'inflight',onboard:{Y:80,J:0,F:0},timing:flightCountdownObservation(a.aircraftId,a.routeId,'01:00:00',new Date().toISOString())})};
 const executor=new IndividualDepartureExecutor(port,readDemandConfig({}),{dryRun:false,maxDepartures:2,fuelHoldingLbsAtRunStart:100000},async()=>{});
 const r=await executor.run();
 expect(clicks).toBe(1);
 expect(r.entries[0]).toMatchObject({status:'held',reason:'FUEL_REQUIREMENT_UNVERIFIED'});
 expect(r.entries[1].status).toBe('departed');
 expect(r.entries[1].resourceEvidence).toMatchObject({trackingComplete:true,verifiedRouteFuelLbs:20000});
});


test('completion reserve holds before fresh evaluation and avoids expensive reads near deadline',async()=>{
 const s=setup({mutationDeadlineEpochMs:Date.now()+60_000});
 const r=await s.executor.run();
 expect(s.clicks()).toBe(0);
 expect(s.reads()).toBe(1); // initial snapshot only; no per-aircraft fresh collection
 expect(r.halted).toBe(false);
 expect(r.entries[0]).toMatchObject({status:'held',reason:'RUN_TIME_BUDGET_EXHAUSTED_BEFORE_EVALUATION'});
});
