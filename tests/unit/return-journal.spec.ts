import { test, expect } from '@playwright/test';
import { mkdtemp, readFile, writeFile, mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { appendFlightHistoryAnchors, compareFlightHistoryAnchors, flightHistoryContinuityDiagnostics, reviewWithReturnJournal } from '../../optimization/return-journal';
import { RouteReview } from '../../optimization/route-optimizer';
const now = new Date('2026-09-30T11:00:00Z');
function input(flightId='flight-1'): RouteReview {
  const leg={from:'AAA',to:'BBB',distanceKm:1000,durationHours:2,originRunwayFt:10000,destinationRunwayFt:10000,demandPool:'AAA-BBB',remaining:{Y:1000,J:0,F:0},automaticFares:{Y:1000,J:0,F:0},expectedLoadFactor:{Y:1,J:0,F:0},costs:{fuel:1000,co2:100,maintenance:100,airportAndOther:100}};
  return {position:{aircraftId:'1',homeBase:'AAA',airport:'AAA',state:'landed',flightId,destination:null,observedAt:now.toISOString()},previousPosition:{aircraftId:'1',homeBase:'AAA',airport:null,state:'inflight',flightId,destination:'AAA',observedAt:'2026-09-30T10:30:00Z'},capacity:{Y:100,J:0,F:0},rangeKm:5000,minRunwayFt:5000,enforceRunway:true,currentRouteId:'current',candidatesComplete:true,candidates:[{id:'current',observedAt:now.toISOString(),setupCost:0,demandNetOfOtherAircraft:true,legs:[leg,{...leg,from:'BBB',to:'AAA'}]}]};
}
let directory: string;
test.beforeEach(async()=>{directory=await mkdtemp(join(tmpdir(),'am4-journal-'));});
test.afterEach(async()=>{await rm(directory,{recursive:true,force:true});});
const options=()=>({directory,scope:'company-test',origin:'AAA'});
test('fresh instances retain reviews across process-style reopen',async()=>{
  expect((await reviewWithReturnJournal(input(),options(),now)).decision).toBe('keep_route');
  expect((await reviewWithReturnJournal(input(),options(),now)).decision).toBe('already_reviewed');
  const saved=JSON.parse(await readFile(join(directory,'return-journal.json'),'utf8'));
  expect(saved.entries).toHaveLength(1);
  expect(saved.entries[0]).toMatchObject({aircraftId:'1',origin:'AAA',flightId:'flight-1',reviewedAt:now.toISOString(),decision:'keep_route',reviewEvidence:{trigger:'return',reviewedRouteId:'current',selectedRouteId:'current',result:'keep_route'}});
  expect(saved.entries[0].reviewEvidence.routePerformance).toEqual([{routeId:'current',viable:true,netProfit:217400,netProfitPerHour:54350,occupancyPercentages:[100,100]}]);
});
test('next flight is reviewed, old flight remains deduplicated',async()=>{
  await reviewWithReturnJournal(input(),options(),now);
  expect((await reviewWithReturnJournal(input('flight-2'),options(),now)).decision).toBe('keep_route');
  expect((await reviewWithReturnJournal(input(),options(),now)).decision).toBe('already_reviewed');
});
test('unavailable candidate data does not consume the return',async()=>{
  const r=input();r.candidatesComplete=false;
  expect((await reviewWithReturnJournal(r,options(),now)).decision).toBe('unavailable');
  expect((await reviewWithReturnJournal(input(),options(),now)).decision).toBe('keep_route');
});
test('landing at another airport does not consume return',async()=>{
  const r=input();r.position.airport='BBB';
  expect((await reviewWithReturnJournal(r,options(),now)).decision).toBe('not_at_base_return');
  expect((await reviewWithReturnJournal(input(),options(),now)).decision).toBe('keep_route');
});
test('corrupted state blocks and preserves evidence',async()=>{
  const p=join(directory,'return-journal.json');await writeFile(p,'broken');
  await expect(reviewWithReturnJournal(input(),options(),now)).rejects.toThrow('JOURNAL_UNAVAILABLE');expect(await readFile(p,'utf8')).toBe('broken');
});
test('different company cannot reuse journal',async()=>{
  await reviewWithReturnJournal(input(),options(),now);
  await expect(reviewWithReturnJournal(input(),{...options(),scope:'other-company'},now)).rejects.toThrow('JOURNAL_UNAVAILABLE');
});
test('wrong registered origin is rejected before review',async()=>{
  await expect(reviewWithReturnJournal(input(),{...options(),origin:'CCC'},now)).rejects.toThrow('JOURNAL_ORIGIN_MISMATCH');
});
test('concurrent transactions cannot both review one arrival',async()=>{
  const r=await Promise.allSettled([reviewWithReturnJournal(input(),options(),now),reviewWithReturnJournal(input(),options(),now)]);
  expect(r.filter(x=>x.status==='fulfilled' && x.value.decision==='keep_route')).toHaveLength(1);
  expect((await reviewWithReturnJournal(input(),options(),now)).decision).toBe('already_reviewed');
});
test('existing lock blocks without deleting another transaction lock',async()=>{
  await mkdir(join(directory,'.return-journal.lock'));
  await expect(reviewWithReturnJournal(input(),options(),now)).rejects.toThrow('[Lock]');
});
test('duplicate saved entries are invalid',async()=>{
  await reviewWithReturnJournal(input(),options(),now);const p=join(directory,'return-journal.json');const d=JSON.parse(await readFile(p,'utf8'));d.entries.push(d.entries[0]);await writeFile(p,JSON.stringify(d));
  await expect(reviewWithReturnJournal(input('flight-2'),options(),now)).rejects.toThrow('JOURNAL_UNAVAILABLE');
});
test('simulated hold is completed and deduplicated',async()=>{
  const r=input();r.candidates[0].legs.forEach(l=>l.remaining.Y=0);
  const plan=await reviewWithReturnJournal(r,options(),now);expect(plan.decision).toBe('hold');expect(plan.mutationAuthorized).toBe(false);
  expect((await reviewWithReturnJournal(r,options(),now)).decision).toBe('already_reviewed');
});
test('unreadable state destination blocks recommendations',async()=>{
  // A directory instead of the state file must not be treated as a first execution.
  await mkdir(join(directory,'return-journal.json'));
  await expect(reviewWithReturnJournal(input(),options(),now)).rejects.toThrow('JOURNAL_UNAVAILABLE');
});

test('daily review requires no fabricated flight ID and deduplicates across reopen', async () => {
  const r=input();r.trigger='daily';r.previousPosition=null;r.position.flightId=null;
  expect((await reviewWithReturnJournal(r,options(),now)).decision).toBe('keep_route');
  expect((await reviewWithReturnJournal(r,options(),now)).decision).toBe('already_reviewed');
  const saved=JSON.parse(await readFile(join(directory,'return-journal.json'),'utf8'));
  expect(saved.entries[0].flightId).toBe('daily_20260930');
  const tomorrow=new Date('2026-10-01T11:00:00Z');r.position.observedAt=tomorrow.toISOString();r.candidates.forEach(c=>c.observedAt=tomorrow.toISOString());
  expect((await reviewWithReturnJournal(r,options(),tomorrow)).decision).toBe('keep_route');
});
test('failed daily comparison stays pending and is retryable the same day', async () => {
  const r=input();r.trigger='daily';r.previousPosition=null;r.position.flightId=null;r.candidatesComplete=false;
  expect((await reviewWithReturnJournal(r,options(),now)).decision).toBe('unavailable');
  r.candidatesComplete=true;
  expect((await reviewWithReturnJournal(r,options(),now)).decision).toBe('keep_route');
});
test('daily review away from base cannot be recorded', async () => {
  const r=input();r.trigger='daily';r.position.airport='BBB';
  expect((await reviewWithReturnJournal(r,options(),now)).decision).toBe('not_at_base_return');
  r.position.airport='AAA';
  expect((await reviewWithReturnJournal(r,options(),now)).decision).toBe('keep_route');
});

test('legacy entry remains valid while new entries append enriched evidence',async()=>{
  const p=join(directory,'return-journal.json');
  await writeFile(p,JSON.stringify({schemaVersion:1,scope:'company-test',entries:[{aircraftId:'1',origin:'AAA',flightId:'legacy',reviewedAt:'2026-09-29T11:00:00.000Z',decision:'keep_route'}]}));
  expect((await reviewWithReturnJournal(input('flight-new'),options(),now)).decision).toBe('keep_route');
  const saved=JSON.parse(await readFile(p,'utf8'));
  expect(saved.entries[0]).toEqual({aircraftId:'1',origin:'AAA',flightId:'legacy',reviewedAt:'2026-09-29T11:00:00.000Z',decision:'keep_route'});
  expect(saved.entries[1].reviewEvidence).toMatchObject({trigger:'return',reviewedRouteId:'current',result:'keep_route'});
});

test('confirmed departure history is append-only and deduplicated by run aircraft route',async()=>{
  await reviewWithReturnJournal(input(),options(),now);
  const {appendConfirmedDepartures}=await import('../../optimization/return-journal');
  const report:any={entries:[{aircraftId:'1',registration:'TEST-1',routeId:'current',from:'AAA',to:'BBB',status:'departed',reason:'NATIVE_INFLIGHT_IDENTITY_COUNTDOWN_AND_ONBOARD_CONFIRMED',
    actualOnboard:{Y:88,J:0,F:0},demand:{availableBefore:{Y:100,J:0,F:0},possiblePassengers:{Y:100,J:0,F:0},occupancyPercentage:100}}]};
  expect(await appendConfirmedDepartures(directory,'company-test','123',report,now)).toBe(1);
  expect(await appendConfirmedDepartures(directory,'company-test','123',report,now)).toBe(0);
  const saved=JSON.parse(await readFile(join(directory,'return-journal.json'),'utf8'));
  expect(saved.events).toEqual([{eventId:'dep_123_1_current',type:'departure',aircraftId:'1',registration:'TEST-1',routeId:'current',from:'AAA',to:'BBB',observedAt:now.toISOString(),result:'departed',demand:{availableBefore:{Y:100,J:0,F:0},possiblePassengers:{Y:100,J:0,F:0},occupancyPercentage:100},actualOnboard:{Y:88,J:0,F:0}}]);
});
test('uncertain departure is not confirmed but becomes a durable no-retry event',async()=>{
  await reviewWithReturnJournal(input(),options(),now);const {appendConfirmedDepartures}=await import('../../optimization/return-journal');
  const report:any={entries:[{status:'held'},{status:'outcome_unknown',aircraftId:'9',registration:'UNCERTAIN',routeId:'99',from:'AAA',to:'BBB',reason:'NO_RETRY_AFTER_CLICK_ATTEMPT:UNCLASSIFIED'}]};
  expect(await appendConfirmedDepartures(directory,'company-test','124',report,now)).toBe(0);
  const {appendUncertainDepartures,readUnresolvedDepartureKeys}=await import('../../optimization/return-journal');expect(await appendUncertainDepartures(directory,'company-test','124',report,now)).toBe(1);
  const saved=JSON.parse(await readFile(join(directory,'return-journal.json'),'utf8'));expect(saved.events[0]).toMatchObject({type:'departure-uncertain',aircraftId:'9',routeId:'99',result:'outcome_unknown',sourceRunId:'124'});expect((await readUnresolvedDepartureKeys(directory,'company-test',now)).has('9:99')).toBe(true);
});

test('strictly newer verified live state resolves an uncertain departure without rewriting history',async()=>{
  await reviewWithReturnJournal(input(),options(),now);
  const {appendUncertainDepartures,appendResolvedUncertainDepartures,readUnresolvedDepartureKeys}=await import('../../optimization/return-journal');
  const report:any={entries:[{status:'outcome_unknown',aircraftId:'9',registration:'UNCERTAIN',routeId:'99',from:'AAA',to:'BBB',reason:'NO_RETRY_AFTER_CLICK_ATTEMPT:UNCLASSIFIED'}]};
  expect(await appendUncertainDepartures(directory,'company-test','124',report,now)).toBe(1);
  const observedAt='2026-09-30T11:10:00.000Z',later=new Date('2026-09-30T11:11:00.000Z');
  const collection:any={complete:true,expectedRoutes:1,warnings:[],aircraft:[{
    aircraftId:'9',registration:'UNCERTAIN',routeId:'99',routeLabel:'AAA - BBB',from:'AAA',to:'BBB',state:'ready',
    capacity:{Y:100,J:0,F:0},remaining:{Y:90,J:0,F:0},dailyTotal:{Y:1000,J:0,F:0},observedAt,
    departureControlShape:"Ajax('route_depart.php?id=<value>&ref=list&costIndex=<number>','<string>',this);"
  }]};
  expect(await appendResolvedUncertainDepartures(directory,'company-test',collection,later)).toBe(1);
  expect((await readUnresolvedDepartureKeys(directory,'company-test',later)).has('9:99')).toBe(false);
  const saved=JSON.parse(await readFile(join(directory,'return-journal.json'),'utf8'));
  expect(saved.events).toEqual(expect.arrayContaining([
    expect.objectContaining({type:'departure-uncertain',aircraftId:'9',routeId:'99'}),
    expect.objectContaining({type:'departure-uncertain-resolved',uncertainEventId:'unc_124_9_99',aircraftId:'9',routeId:'99',result:'live_state_verified',liveState:'ready'})
  ]));
});

test('stale or mismatched live evidence never resolves an uncertain departure',async()=>{
  await reviewWithReturnJournal(input(),options(),now);
  const {appendUncertainDepartures,appendResolvedUncertainDepartures,readUnresolvedDepartureKeys}=await import('../../optimization/return-journal');
  const report:any={entries:[{status:'outcome_unknown',aircraftId:'9',registration:'UNCERTAIN',routeId:'99',from:'AAA',to:'BBB',reason:'NO_RETRY_AFTER_CLICK_ATTEMPT:UNCLASSIFIED'}]};
  await appendUncertainDepartures(directory,'company-test','125',report,now);
  const base:any={aircraftId:'9',registration:'UNCERTAIN',routeId:'99',routeLabel:'AAA - BBB',from:'AAA',to:'BBB',state:'ready',
    capacity:{Y:100,J:0,F:0},remaining:{Y:90,J:0,F:0},dailyTotal:{Y:1000,J:0,F:0},
    departureControlShape:'verified'};
  expect(await appendResolvedUncertainDepartures(directory,'company-test',{complete:true,expectedRoutes:1,warnings:[],aircraft:[{...base,observedAt:now.toISOString()}]},new Date('2026-09-30T11:20:00Z'))).toBe(0);
  expect(await appendResolvedUncertainDepartures(directory,'company-test',{complete:true,expectedRoutes:1,warnings:[],aircraft:[{...base,registration:'OTHER',observedAt:'2026-09-30T11:15:00Z'}]},new Date('2026-09-30T11:20:00Z'))).toBe(0);
  expect((await readUnresolvedDepartureKeys(directory,'company-test',new Date('2026-09-30T11:20:00Z'))).has('9:99')).toBe(true);
});

test('verified supply observations append once per run and kind',async()=>{
 await reviewWithReturnJournal(input(),options(),now);const {appendSupplyObservation}=await import('../../optimization/return-journal');
 const snap={pricePer1000:500,holding:1000,remainingCapacity:2000,balance:3000};
 expect(await appendSupplyObservation(directory,'company-test','200','fuel',snap,now)).toBe(true);
 expect(await appendSupplyObservation(directory,'company-test','200','fuel',snap,now)).toBe(false);
 expect(await appendSupplyObservation(directory,'company-test','200','co2',{...snap,pricePer1000:110},now)).toBe(true);
 const saved=JSON.parse(await readFile(join(directory,'return-journal.json'),'utf8'));expect(saved.supplyObservations).toHaveLength(2);expect(saved.supplyObservations[0]).toMatchObject({eventId:'sup_200_fuel',kind:'fuel',pricePer1000:500});
});

test('verified demand holds append only when executor observed insufficient demand',async()=>{
 await reviewWithReturnJournal(input(),options(),now);const {appendDemandHoldObservations}=await import('../../optimization/return-journal');
 const report={entries:[{status:'held',aircraftId:'1',routeId:'10',demand:{decision:'hold_insufficient',occupancyPercentage:25}},{status:'held',aircraftId:'2',routeId:'20',demand:null},{status:'departed',aircraftId:'3',routeId:'30',demand:{decision:'would_depart',occupancyPercentage:100}}]};
 expect(await appendDemandHoldObservations(directory,'company-test','300',report,now)).toBe(1);expect(await appendDemandHoldObservations(directory,'company-test','300',report,now)).toBe(0);
 const saved=JSON.parse(await readFile(join(directory,'return-journal.json'),'utf8'));expect(saved.holdObservations).toEqual([{eventId:'hold_300_1_10',type:'demand-hold',aircraftId:'1',routeId:'10',observedAt:now.toISOString(),occupancyPercentage:25,reason:'hold_insufficient'}]);
});

test('verified variable KEEP closes daily review without consuming reroute decisions',async()=>{
 await reviewWithReturnJournal(input(),options(),now);const {appendVerifiedKeepRouteDecisions}=await import('../../optimization/return-journal');const tomorrow=new Date('2026-10-03T20:00:00Z');const fleet=[{aircraftId:'1',routeId:'10',from:'GRU',to:'SCL',state:'ready',issue:null}];const cycle={aircraftId:'1',from:'GRU',to:'SCL',comparisonReady:true,recurringCycleProfit:{expected:1000},recurringCycleProfitPerHour:{expected:500}};const candidates=[{aircraftId:'1',comparisonReady:true,variableCycleComparison:{status:'keep_current',comparisonReady:true,current:cycle}},{aircraftId:'1',comparisonReady:true,variableCycleComparison:{status:'keep_current',comparisonReady:true,current:cycle}}];const keep=[{aircraftId:'1',decision:'keep_route',selected:null,compared:2,reason:'NO_INSPECTED_CANDIDATE_PROVES_CONSERVATIVE_DOMINANCE'}];expect(await appendVerifiedKeepRouteDecisions(directory,'company-test',keep,candidates,fleet,new Map([['1','GRU']]),'America/Sao_Paulo',tomorrow)).toBe(1);expect(await appendVerifiedKeepRouteDecisions(directory,'company-test',keep,candidates,fleet,new Map([['1','GRU']]),'America/Sao_Paulo',tomorrow)).toBe(0);const saved=JSON.parse(await readFile(join(directory,'return-journal.json'),'utf8'));expect(saved.entries.at(-1)).toMatchObject({aircraftId:'1',origin:'GRU',flightId:'daily_20261003',decision:'keep_route',reviewEvidence:{reviewedRouteId:'10',result:'keep_route'}});const reroute=[{...keep[0],decision:'would_reroute',selected:{from:'GRU',to:'AAA',airportId:'99'}}];expect(await appendVerifiedKeepRouteDecisions(directory,'company-test',reroute,candidates,fleet,new Map([['1','GRU']]),'America/Sao_Paulo',new Date('2026-10-04T20:00:00Z'))).toBe(0);
});

test('confirmed return after earlier daily KEEP persists a distinct same-day return review',async()=>{
 const {appendVerifiedKeepRouteDecisions}=await import('../../optimization/return-journal');
 const when=new Date('2026-10-07T20:00:00Z');
 const departure={eventId:'dep_return_1',type:'departure',aircraftId:'1',registration:'TEST',routeId:'10',from:'SCL',to:'GRU',
  observedAt:'2026-10-07T16:00:00Z',result:'departed',
  demand:{availableBefore:{Y:100,J:0,F:0},possiblePassengers:{Y:100,J:0,F:0},occupancyPercentage:100},actualOnboard:{Y:100,J:0,F:0}};
 const arrival={eventId:'arr_dep_return_1',type:'arrival-observed',departureEventId:'dep_return_1',aircraftId:'1',registration:'TEST',
  routeId:'10',from:'SCL',to:'GRU',departedAt:departure.observedAt,observedAt:'2026-10-07T18:00:00Z',result:'arrived_observed'};
 await mkdir(directory,{recursive:true});
 await writeFile(join(directory,'return-journal.json'),JSON.stringify({schemaVersion:1,scope:'company-test',
  entries:[{aircraftId:'1',origin:'GRU',flightId:'daily_20261007',reviewedAt:'2026-10-07T15:00:00Z',decision:'keep_route'}],
  events:[departure,arrival]})+'\n');
 const fleet=[{aircraftId:'1',registration:'TEST',routeId:'10',from:'GRU',to:'SCL',state:'ready',issue:null}];
 const cycle={aircraftId:'1',from:'GRU',to:'SCL',comparisonReady:true,recurringCycleProfit:{expected:1000},recurringCycleProfitPerHour:{expected:500}};
 const candidates=[{aircraftId:'1',comparisonReady:true,variableCycleComparison:{status:'keep_current',comparisonReady:true,current:cycle}}];
 const decisions=[{aircraftId:'1',decision:'keep_route',selected:null,compared:1,reason:'NO_INSPECTED_CANDIDATE_PROVES_CONSERVATIVE_DOMINANCE'}];
 expect(await appendVerifiedKeepRouteDecisions(directory,'company-test',decisions,candidates,fleet,new Map([['1','GRU']]),'America/Sao_Paulo',when)).toBe(1);
 const saved=JSON.parse(await readFile(join(directory,'return-journal.json'),'utf8'));
 expect(saved.entries.at(-1)).toMatchObject({aircraftId:'1',origin:'GRU',flightId:'arr_dep_return_1',decision:'keep_route',
  reviewEvidence:{trigger:'return',reviewedRouteId:'10',result:'keep_route'}});
 expect(await appendVerifiedKeepRouteDecisions(directory,'company-test',decisions,candidates,fleet,new Map([['1','GRU']]),'America/Sao_Paulo',when)).toBe(0);
});

test('reroute review is persisted only after a fresh confirmed route id',async()=>{
 await reviewWithReturnJournal(input(),options(),now);const {appendConfirmedRerouteReviews}=await import('../../optimization/return-journal');const when=new Date('2026-10-05T20:00:00Z'),fleet=[{aircraftId:'1',routeId:'10',from:'GRU',to:'SCL',state:'ready',issue:null}],current={aircraftId:'1',from:'GRU',to:'SCL',comparisonReady:true,recurringCycleProfit:{expected:1000},recurringCycleProfitPerHour:{expected:500}},candidate={aircraftId:'1',from:'GRU',to:'AAA',comparisonReady:true,recurringCycleProfit:{expected:3000},recurringCycleProfitPerHour:{expected:900}};const decisions=[{aircraftId:'1',decision:'would_reroute',selected:{from:'GRU',to:'AAA',airportId:'99'},compared:1,dominating:1}],candidates=[{aircraftId:'1',from:'GRU',to:'AAA',airportId:'99',comparisonReady:true,variableCycleComparison:{status:'candidate_dominates',comparisonReady:true,current},candidateVariableCycle:candidate}],entry={aircraftId:'1',status:'rerouted',reason:'NATIVE_REROUTE_AND_FRESH_ROUTE_CONFIRMED',previousRouteId:'10',previousFrom:'GRU',previousTo:'SCL',targetFrom:'GRU',targetTo:'AAA',targetAirportId:'99',confirmedRouteId:'20'};expect(await appendConfirmedRerouteReviews(directory,'company-test',decisions,candidates,fleet,new Map([['1','GRU']]),{halted:false,entries:[{...entry,status:'outcome_unknown'}]},'America/Sao_Paulo',when)).toBe(0);expect(await appendConfirmedRerouteReviews(directory,'company-test',decisions,candidates,fleet,new Map([['1','GRU']]),{halted:false,entries:[entry]},'America/Sao_Paulo',when)).toBe(1);const saved=JSON.parse(await readFile(join(directory,'return-journal.json'),'utf8'));expect(saved.entries.at(-1)).toMatchObject({flightId:'daily_20261005',decision:'would_reroute',reviewEvidence:{reviewedRouteId:'10',selectedRouteId:'20',result:'would_reroute'}});
});

test('modern daily KEEP does not duplicate a completed return review from the same day',async()=>{
 const {appendVerifiedKeepRouteDecisions}=await import('../../optimization/return-journal');const when=new Date('2026-10-06T20:00:00Z');await mkdir(directory,{recursive:true});await writeFile(join(directory,'return-journal.json'),JSON.stringify({schemaVersion:1,scope:'company-test',entries:[{aircraftId:'1',origin:'GRU',flightId:'flight_123',reviewedAt:'2026-10-06T15:00:00Z',decision:'keep_route'}]})+'\n');const fleet=[{aircraftId:'1',routeId:'10',from:'GRU',to:'SCL',state:'ready',issue:null}],cycle={aircraftId:'1',from:'GRU',to:'SCL',comparisonReady:true,recurringCycleProfit:{expected:1000},recurringCycleProfitPerHour:{expected:500}},candidates=[{aircraftId:'1',comparisonReady:true,variableCycleComparison:{status:'keep_current',comparisonReady:true,current:cycle}}],decisions=[{aircraftId:'1',decision:'keep_route',selected:null,compared:1,reason:'NO_INSPECTED_CANDIDATE_PROVES_CONSERVATIVE_DOMINANCE'}];expect(await appendVerifiedKeepRouteDecisions(directory,'company-test',decisions,candidates,fleet,new Map([['1','GRU']]),'America/Sao_Paulo',when)).toBe(0);
});


test('compact flight-history anchor persists only uncovered observed aircraft',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'am4-anchor-'));try{await writeFile(join(dir,'return-journal.json'),JSON.stringify({schemaVersion:1,scope:'company-test',entries:[]}));const now=new Date();const row={relativeTime:'21 hours ago',from:'AAA',to:'BBB',registrationLabel:'FAST',co2Quotas:1,onboard:{Y:1,J:0,F:0},fuelLbs:2,revenue:3};const collection:any={aircraft:[{aircraftId:'1',registration:'FAST',operational:{cycles:190},flightHistory:{status:'observed',observedAt:now.toISOString(),entries:[row,row,row,row]}}]};const coverage:any[]=[{aircraftId:'1',historyStatus:'observed',visibleEntries:4,coversReset:false}];expect(await appendFlightHistoryAnchors(dir,'company-test','123',collection,coverage,now)).toBe(1);const saved=JSON.parse(await readFile(join(dir,'return-journal.json'),'utf8'));expect(saved.events).toHaveLength(1);expect(saved.events[0]).toMatchObject({eventId:'hist_123_1',type:'flight-history-anchor',aircraftId:'1',cycles:190});expect(saved.events[0].rows).toHaveLength(4);}finally{await rm(dir,{recursive:true,force:true});}
});


test('unchanged completed-flight history does not append a redundant anchor on the next run',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'am4-anchor-dedupe-'));
 try{
  await writeFile(join(dir,'return-journal.json'),JSON.stringify({schemaVersion:1,scope:'company-test',entries:[]}));
  const row=(relativeTime:string)=>({relativeTime,from:'AAA',to:'BBB',registrationLabel:'FAST',co2Quotas:1,onboard:{Y:1,J:0,F:0},fuelLbs:2,revenue:3});
  const firstNow=new Date('2026-10-07T00:00:00Z');
  const first:any={aircraft:[{aircraftId:'1',registration:'FAST',operational:{cycles:190},flightHistory:{status:'observed',observedAt:firstNow.toISOString(),entries:[row('21 hours ago'),row('22 hours ago')]}}]};
  const coverage:any[]=[{aircraftId:'1',historyStatus:'observed',visibleEntries:2,coversReset:false}];
  expect(await appendFlightHistoryAnchors(dir,'company-test','run1',first,coverage,firstNow)).toBe(1);

  const secondNow=new Date('2026-10-07T00:30:00Z');
  const second:any={aircraft:[{aircraftId:'1',registration:'FAST',operational:{cycles:190},flightHistory:{status:'observed',observedAt:secondNow.toISOString(),entries:[row('21.5 hours ago'),row('22.5 hours ago')]}}]};
  expect(await appendFlightHistoryAnchors(dir,'company-test','run2',second,coverage,secondNow)).toBe(0);
  const saved=JSON.parse(await readFile(join(dir,'return-journal.json'),'utf8'));
  expect(saved.events).toHaveLength(1);
 }finally{await rm(dir,{recursive:true,force:true});}
});

test('diagnostic flight-history anchors preserve transport capacity for critical journal events',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'am4-anchor-budget-'));
 try{
  const entries=Array.from({length:5700},(_,i)=>({
   aircraftId:'1',origin:'AAA',flightId:'f'+i,reviewedAt:'2026-10-06T00:00:00.000Z',decision:'keep_route'
  }));
  await writeFile(join(dir,'return-journal.json'),JSON.stringify({schemaVersion:1,scope:'company-test',entries}));
  const now=new Date('2026-10-07T00:00:00Z');
  const row={relativeTime:'21 hours ago',from:'AAA',to:'BBB',registrationLabel:'FAST',co2Quotas:1,onboard:{Y:1,J:0,F:0},fuelLbs:2,revenue:3};
  const collection:any={aircraft:[{aircraftId:'1',registration:'FAST',operational:{cycles:190},flightHistory:{status:'observed',observedAt:now.toISOString(),entries:[row,row,row,row]}}]};
  const coverage:any[]=[{aircraftId:'1',historyStatus:'observed',visibleEntries:4,coversReset:false}];
  expect(Buffer.byteLength(JSON.stringify({schemaVersion:1,scope:'company-test',entries}))).toBeGreaterThan(650000);
  expect(await appendFlightHistoryAnchors(dir,'company-test','budget1',collection,coverage,now)).toBe(0);
  const saved=JSON.parse(await readFile(join(dir,'return-journal.json'),'utf8'));
  expect(saved.events).toBeUndefined();
 }finally{await rm(dir,{recursive:true,force:true});}
});

test('persisted flight-history anchors prove overlap only as read-only evidence',()=>{
 const row=(age:string,from:string,to:string,revenue:number)=>({relativeTime:age,from,to,co2Quotas:10,onboard:{Y:5,J:0,F:0},fuelLbs:100,revenue});
 const previous:any={eventId:'hist_1_1',type:'flight-history-anchor',aircraftId:'1',registration:'FAST',observedAt:'2026-10-03T19:00:00Z',cycles:190,rows:[row('18 hours ago','AAA','BBB',1000),row('19 hours ago','BBB','AAA',900),row('20 hours ago','AAA','BBB',800)]};
 const current:any={eventId:'hist_2_1',type:'flight-history-anchor',aircraftId:'1',registration:'FAST',observedAt:'2026-10-03T20:00:00Z',cycles:191,rows:[row('20 hours ago','BBB','AAA',900),row('21 hours ago','AAA','BBB',800),row('22 hours ago','BBB','AAA',700)]};
 expect(compareFlightHistoryAnchors(previous,current)).toMatchObject({status:'verified_overlap',cycleDelta:1,overlapRows:2,reason:'PERSISTED_FLIGHT_ROWS_OVERLAP_VERIFIED',comparisonReady:false,mutationAuthorized:false});
 current.rows=[row('20 hours ago','AAA','BBB',800),row('21 hours ago','AAA','BBB',800)];
 expect(compareFlightHistoryAnchors(previous,current)).toMatchObject({status:'unavailable',reason:'ANCHOR_OVERLAP_INSUFFICIENT',comparisonReady:false,mutationAuthorized:false});
 const duplicate=row('1 hour ago','AAA','BBB',777),other=row('2 hours ago','BBB','AAA',666);
 previous.rows=[duplicate,other,duplicate,other];current.rows=[duplicate,other];
 expect(compareFlightHistoryAnchors(previous,current)).toMatchObject({status:'unavailable',reason:'ANCHOR_OVERLAP_ALIGNMENT_AMBIGUOUS',comparisonReady:false,mutationAuthorized:false});
 previous.rows=[duplicate,other,duplicate];current.rows=[row('30 mins ago','CCC','DDD',555),duplicate,other,duplicate];
 expect(compareFlightHistoryAnchors(previous,current)).toMatchObject({status:'verified_overlap',overlapRows:3,reason:'PERSISTED_FLIGHT_ROWS_OVERLAP_VERIFIED',comparisonReady:false,mutationAuthorized:false});
});


test('journal continuity diagnostics compares only the latest two persisted anchors per aircraft',()=>{
 const row=(from:string,to:string,revenue:number)=>({relativeTime:'1 hour ago',from,to,co2Quotas:1,onboard:{Y:1,J:0,F:0},fuelLbs:2,revenue});
 const anchor=(eventId:string,observedAt:string,cycles:number,rows:any[])=>({eventId,type:'flight-history-anchor' as const,aircraftId:'1',registration:'FAST',observedAt,cycles,rows});
 const shared1=row('AAA','BBB',100),shared2=row('BBB','AAA',90);
 const journal:any={schemaVersion:1,scope:'x',entries:[],events:[anchor('hist_1','2026-10-03T18:00:00Z',10,[row('CCC','DDD',70)]),anchor('hist_2','2026-10-03T19:00:00Z',11,[shared1,shared2]),anchor('hist_3','2026-10-03T20:00:00Z',12,[shared1,shared2,row('EEE','FFF',80)])]};
 expect(flightHistoryContinuityDiagnostics(journal)).toEqual([expect.objectContaining({status:'verified_overlap',aircraftId:'1',cycleDelta:1,overlapRows:2,comparisonReady:false,mutationAuthorized:false})]);
});


test('conservative stitched history requires cycle-aligned live-shaped overlap and rebases ages',async()=>{
 const {buildConservativeFlightHistoryStitch}=await import('../../optimization/return-journal');
 const row=(age:string,from:string,to:string,revenue:number)=>({relativeTime:age,from,to,co2Quotas:10,onboard:{Y:5,J:0,F:0},fuelLbs:100,revenue});
 const previous:any={eventId:'hist_prev',type:'flight-history-anchor',aircraftId:'1',registration:'FAST',observedAt:'2026-10-03T21:00:00Z',cycles:193,rows:[
   row('14 hours ago','AAA','BBB',100),row('15 hours ago','BBB','AAA',101),row('16 hours ago','AAA','BBB',102),row('17 hours ago','BBB','AAA',103),row('18 hours ago','AAA','BBB',104),row('19 hours ago','BBB','AAA',105),row('20 hours ago','AAA','BBB',106),row('21 hours ago','BBB','AAA',107)
 ]};
 const current:any={eventId:'hist_cur',type:'flight-history-anchor',aircraftId:'1',registration:'FAST',observedAt:'2026-10-04T00:00:00Z',cycles:196,rows:[
   row('14 hours ago','BBB','AAA',201),row('15 hours ago','AAA','BBB',202),row('16 hours ago','BBB','AAA',203),
   row('17 hours ago','AAA','BBB',100),row('18 hours ago','BBB','AAA',101),row('19 hours ago','AAA','BBB',102),row('20 hours ago','BBB','AAA',103),row('21 hours ago','AAA','BBB',104)
 ]};
 const stitched=buildConservativeFlightHistoryStitch([previous,current]);
 expect(stitched).toMatchObject({status:'verified_chain',anchorsUsed:2,linksVerified:1,rowsStitched:11,reason:'PERSISTED_FLIGHT_HISTORY_STITCH_VERIFIED',comparisonReady:false,mutationAuthorized:false});
 expect(stitched.oldestAgeLowerMinutes).toBe(24*60);
});

test('stitched history rejects overlap whose position disagrees with cycle delta',async()=>{
 const {buildConservativeFlightHistoryStitch}=await import('../../optimization/return-journal');
 const row=(age:string,from:string,to:string,revenue:number)=>({relativeTime:age,from,to,co2Quotas:10,onboard:{Y:5,J:0,F:0},fuelLbs:100,revenue});
 const shared=[row('10 hours ago','AAA','BBB',1),row('11 hours ago','BBB','AAA',2),row('12 hours ago','AAA','BBB',3)];
 const previous:any={eventId:'hist_prev2',type:'flight-history-anchor',aircraftId:'1',registration:'FAST',observedAt:'2026-10-03T20:00:00Z',cycles:10,rows:shared};
 const current:any={eventId:'hist_cur2',type:'flight-history-anchor',aircraftId:'1',registration:'FAST',observedAt:'2026-10-03T21:00:00Z',cycles:11,rows:shared};
 const stitched=buildConservativeFlightHistoryStitch([previous,current]);
 expect(stitched).toMatchObject({status:'unavailable',linksVerified:0,stoppedReason:'STITCH_CYCLE_ALIGNMENT_UNVERIFIED',comparisonReady:false,mutationAuthorized:false});
});

test('stitched history rejects identity overlap when relative-age evidence is incompatible',async()=>{
 const {buildConservativeFlightHistoryStitch}=await import('../../optimization/return-journal');
 const row=(age:string,from:string,to:string,revenue:number)=>({relativeTime:age,from,to,co2Quotas:10,onboard:{Y:5,J:0,F:0},fuelLbs:100,revenue});
 const previous:any={eventId:'hist_prev3',type:'flight-history-anchor',aircraftId:'1',registration:'FAST',observedAt:'2026-10-03T20:00:00Z',cycles:10,rows:[row('10 hours ago','AAA','BBB',1),row('11 hours ago','BBB','AAA',2),row('12 hours ago','AAA','BBB',3)]};
 const current:any={eventId:'hist_cur3',type:'flight-history-anchor',aircraftId:'1',registration:'FAST',observedAt:'2026-10-03T21:00:00Z',cycles:11,rows:[row('1 hour ago','CCC','DDD',9),row('30 hours ago','AAA','BBB',1),row('31 hours ago','BBB','AAA',2)]};
 const stitched=buildConservativeFlightHistoryStitch([previous,current]);
 expect(stitched).toMatchObject({status:'unavailable',linksVerified:0,stoppedReason:'STITCH_OVERLAP_AGE_INCONSISTENT',comparisonReady:false,mutationAuthorized:false});
});


test('uncertain supply mutation becomes a durable per-commodity no-retry quarantine',async()=>{
 await reviewWithReturnJournal(input(),options(),now);
 const {appendUncertainSupplyOperation,readUnresolvedSupplyKinds,validateReturnJournal}=await import('../../optimization/return-journal');
 const entry:any={kind:'co2',status:'unknown',reason:'OUTCOME_UNKNOWN_NO_RETRY:SUPPLY_PRICE_ROLLOVER',before:{pricePer1000:117},plan:{quantity:1396108},quotedCost:163345};
 expect(await appendUncertainSupplyOperation(directory,'company-test','133',entry,now)).toBe(true);
 expect(await appendUncertainSupplyOperation(directory,'company-test','133',entry,now)).toBe(false);
 const kinds=await readUnresolvedSupplyKinds(directory,'company-test',now);
 expect([...kinds]).toEqual(['co2']);
 const saved=JSON.parse(await readFile(join(directory,'return-journal.json'),'utf8'));
 expect(saved.events.at(-1)).toEqual({eventId:'sunc_133_co2',type:'supply-uncertain',kind:'co2',observedAt:now.toISOString(),result:'outcome_unknown',reason:'OUTCOME_UNKNOWN_NO_RETRY:SUPPLY_PRICE_ROLLOVER',sourceRunId:'133',pricePer1000:117,quantity:1396108,quotedCost:163345});
 expect(()=>validateReturnJournal({...saved,events:[...saved.events,{...saved.events.at(-1),eventId:'sunc_bad',quantity:0}]},'company-test',now)).toThrow('JOURNAL_INVALID');
});

test('supply quarantine stays unresolved until a strictly newer verified inventory snapshot exists',async()=>{
 await reviewWithReturnJournal(input(),options(),now);
 const {appendSupplyObservation,appendUncertainSupplyOperation,readUnresolvedSupplyKinds}=await import('../../optimization/return-journal');
 const entry:any={kind:'co2',status:'unknown',reason:'OUTCOME_UNKNOWN_NO_RETRY:SUPPLY_PRICE_ROLLOVER',before:{pricePer1000:117},plan:{quantity:1396108},quotedCost:163345};
 await appendUncertainSupplyOperation(directory,'company-test','133',entry,now);
 expect([...(await readUnresolvedSupplyKinds(directory,'company-test',now))]).toEqual(['co2']);
 // Same-timestamp evidence cannot prove that it was observed after the uncertain mutation.
 await appendSupplyObservation(directory,'company-test','134','co2',{pricePer1000:100,holding:500000,remainingCapacity:500000,balance:1000000},now);
 expect([...(await readUnresolvedSupplyKinds(directory,'company-test',now))]).toEqual(['co2']);
 const later=new Date(now.getTime()+60_000);
 await appendSupplyObservation(directory,'company-test','135','co2',{pricePer1000:99,holding:600000,remainingCapacity:400000,balance:900000},later);
 expect([...(await readUnresolvedSupplyKinds(directory,'company-test',later))]).toEqual([]);
});

test('supply quarantine is independent per commodity and cannot be inferred from passive observations',async()=>{
 await reviewWithReturnJournal(input(),options(),now);
 const {appendSupplyObservation,appendUncertainSupplyOperation,readUnresolvedSupplyKinds}=await import('../../optimization/return-journal');
 expect(await appendSupplyObservation(directory,'company-test','200','fuel',{pricePer1000:100,holding:1,remainingCapacity:2,balance:3},now)).toBe(true);
 expect([...(await readUnresolvedSupplyKinds(directory,'company-test',now))]).toEqual([]);
 const entry:any={kind:'fuel',status:'unknown',reason:'OUTCOME_UNKNOWN_NO_RETRY:SUPPLY_OUTCOME_UNKNOWN',before:{pricePer1000:100},plan:{quantity:1000},quotedCost:100};
 expect(await appendUncertainSupplyOperation(directory,'company-test','200',entry,now)).toBe(true);
 expect([...(await readUnresolvedSupplyKinds(directory,'company-test',now))]).toEqual(['fuel']);
});

test('live-anchored stitched history requires the current snapshot to verify the newest continuity link',async()=>{
 const {buildLiveAnchoredFlightHistoryStitch}=await import('../../optimization/return-journal');
 const row=(age:string,from:string,to:string,revenue:number)=>({relativeTime:age,from,to,registrationLabel:'FAST',co2Quotas:10,onboard:{Y:5,J:0,F:0},fuelLbs:100,revenue});
 const strip=(r:any)=>{const {registrationLabel,...rest}=r;return rest;};
 const persisted:any={eventId:'hist_persisted',type:'flight-history-anchor',aircraftId:'1',registration:'FAST',observedAt:'2026-10-04T00:00:00Z',cycles:10,rows:[
   strip(row('10 hours ago','AAA','BBB',100)),strip(row('11 hours ago','BBB','AAA',90)),strip(row('12 hours ago','AAA','BBB',80))
 ]};
 const aircraft:any={aircraftId:'1',registration:'FAST',routeId:'10',routeLabel:'AAA-BBB',from:'AAA',to:'BBB',state:'ready',capacity:{Y:10,J:0,F:0},remaining:{Y:100,J:0,F:0},dailyTotal:{Y:100,J:0,F:0},observedAt:'2026-10-04T01:00:00Z',
   operational:{cycles:11},flightHistory:{status:'observed',observedAt:'2026-10-04T01:00:00Z',entries:[
     row('10 hours ago','CCC','DDD',110),row('11 hours ago','AAA','BBB',100),row('12 hours ago','BBB','AAA',90),row('13 hours ago','AAA','BBB',80)
   ]}};
 const journal:any={schemaVersion:1,scope:'x',entries:[],events:[persisted]};
 expect(buildLiveAnchoredFlightHistoryStitch(journal,aircraft,new Date('2026-10-04T01:01:00Z'))).toMatchObject({
   status:'verified_chain',liveAnchorVerified:true,persistedAnchorsAvailable:1,anchorsUsed:2,linksVerified:1,rowsStitched:4,
   reason:'LIVE_ANCHORED_FLIGHT_HISTORY_STITCH_VERIFIED',comparisonReady:false,mutationAuthorized:false
 });
});

test('live-anchored stitched history fails closed on stale or conflicting current evidence',async()=>{
 const {buildLiveAnchoredFlightHistoryStitch}=await import('../../optimization/return-journal');
 const row=(age:string,from:string,to:string,revenue:number)=>({relativeTime:age,from,to,registrationLabel:'FAST',co2Quotas:10,onboard:{Y:5,J:0,F:0},fuelLbs:100,revenue});
 const strip=(r:any)=>{const {registrationLabel,...rest}=r;return rest;};
 const persisted:any={eventId:'hist_newer',type:'flight-history-anchor',aircraftId:'1',registration:'FAST',observedAt:'2026-10-04T02:00:00Z',cycles:12,rows:[strip(row('10 hours ago','AAA','BBB',100)),strip(row('11 hours ago','BBB','AAA',90))]};
 const aircraft:any={aircraftId:'1',registration:'FAST',routeId:'10',routeLabel:'AAA-BBB',from:'AAA',to:'BBB',state:'ready',capacity:{Y:10,J:0,F:0},remaining:{Y:100,J:0,F:0},dailyTotal:{Y:100,J:0,F:0},observedAt:'2026-10-04T01:00:00Z',operational:{cycles:11},flightHistory:{status:'observed',observedAt:'2026-10-04T01:00:00Z',entries:[row('10 hours ago','AAA','BBB',100),row('11 hours ago','BBB','AAA',90)]}};
 expect(buildLiveAnchoredFlightHistoryStitch({schemaVersion:1,scope:'x',entries:[],events:[persisted]} as any,aircraft,new Date('2026-10-04T03:00:00Z'))).toMatchObject({
   status:'unavailable',liveAnchorVerified:false,reason:'LIVE_ANCHOR_OLDER_THAN_PERSISTED',comparisonReady:false,mutationAuthorized:false
 });
 const conflicting={...persisted,observedAt:'2026-10-04T01:00:00Z',cycles:11,rows:[strip(row('10 hours ago','AAA','BBB',999)),strip(row('11 hours ago','BBB','AAA',90))]};
 expect(buildLiveAnchoredFlightHistoryStitch({schemaVersion:1,scope:'x',entries:[],events:[conflicting]} as any,aircraft,new Date('2026-10-04T03:00:00Z'))).toMatchObject({
   status:'unavailable',liveAnchorVerified:false,reason:'LIVE_ANCHOR_CONFLICTS_WITH_PERSISTED',comparisonReady:false,mutationAuthorized:false
 });
});

test('confirmed departure is closed only by a later reversed ready snapshot',async()=>{
 const {appendObservedArrivals}=await import('../../optimization/return-journal');
 const departedAt='2026-10-04T10:00:00.000Z',observedAt='2026-10-04T11:00:00.000Z',when=new Date('2026-10-04T11:01:00.000Z');
 const departure={eventId:'dep_900_1_10',type:'departure',aircraftId:'1',registration:'FAST',routeId:'10',from:'AAA',to:'BBB',observedAt:departedAt,result:'departed',
  demand:{availableBefore:{Y:100,J:0,F:0},possiblePassengers:{Y:10,J:0,F:0},occupancyPercentage:100},actualOnboard:{Y:10,J:0,F:0}};
 await mkdir(directory,{recursive:true});await writeFile(join(directory,'return-journal.json'),JSON.stringify({schemaVersion:1,scope:'company-test',entries:[],events:[departure]})+'\n');
 const collection:any={complete:true,expectedRoutes:1,warnings:[],aircraft:[{aircraftId:'1',registration:'FAST',routeId:'10',routeLabel:'BBB-AAA',from:'BBB',to:'AAA',state:'ready',capacity:{Y:10,J:0,F:0},remaining:{Y:100,J:0,F:0},dailyTotal:{Y:100,J:0,F:0},observedAt}]};
 expect(await appendObservedArrivals(directory,'company-test',collection,when)).toBe(1);
 expect(await appendObservedArrivals(directory,'company-test',collection,when)).toBe(0);
 const saved=JSON.parse(await readFile(join(directory,'return-journal.json'),'utf8'));
 expect(saved.events.at(-1)).toEqual({eventId:'arr_dep_900_1_10',type:'arrival-observed',departureEventId:'dep_900_1_10',aircraftId:'1',registration:'FAST',routeId:'10',from:'AAA',to:'BBB',departedAt,observedAt,result:'arrived_observed'});
});

test('arrival observation stays unavailable after a newer uncertain departure or mismatched landing context',async()=>{
 const {appendObservedArrivals}=await import('../../optimization/return-journal');
 const departure={eventId:'dep_901_1_10',type:'departure',aircraftId:'1',registration:'FAST',routeId:'10',from:'AAA',to:'BBB',observedAt:'2026-10-04T09:00:00.000Z',result:'departed',
  demand:{availableBefore:{Y:100,J:0,F:0},possiblePassengers:{Y:10,J:0,F:0},occupancyPercentage:100},actualOnboard:{Y:10,J:0,F:0}};
 const uncertain={eventId:'unc_902_1_10',type:'departure-uncertain',aircraftId:'1',registration:'FAST',routeId:'10',from:'BBB',to:'AAA',observedAt:'2026-10-04T10:00:00.000Z',result:'outcome_unknown',reason:'NO_RETRY_AFTER_CLICK_ATTEMPT:UNCLASSIFIED',sourceRunId:'902'};
 await mkdir(directory,{recursive:true});await writeFile(join(directory,'return-journal.json'),JSON.stringify({schemaVersion:1,scope:'company-test',entries:[],events:[departure,uncertain]})+'\n');
 const ready:any={aircraftId:'1',registration:'FAST',routeId:'10',routeLabel:'BBB-AAA',from:'BBB',to:'AAA',state:'ready',capacity:{Y:10,J:0,F:0},remaining:{Y:100,J:0,F:0},dailyTotal:{Y:100,J:0,F:0},observedAt:'2026-10-04T11:00:00.000Z'};
 expect(await appendObservedArrivals(directory,'company-test',{complete:true,expectedRoutes:1,warnings:[],aircraft:[ready]} as any,new Date('2026-10-04T11:01:00.000Z'))).toBe(0);
 await writeFile(join(directory,'return-journal.json'),JSON.stringify({schemaVersion:1,scope:'company-test',entries:[],events:[departure]})+'\n');
 expect(await appendObservedArrivals(directory,'company-test',{complete:true,expectedRoutes:1,warnings:[],aircraft:[{...ready,from:'CCC',to:'AAA'}]} as any,new Date('2026-10-04T11:01:00.000Z'))).toBe(0);
});



test('uncertain reroute becomes durable aircraft-wide no-retry quarantine',async()=>{
 await reviewWithReturnJournal(input(),options(),now);
 const {appendUncertainRouteMutations,readUnresolvedRouteAircraftIds,validateReturnJournal}=await import('../../optimization/return-journal');
 const report:any={entries:[{aircraftId:'9',registration:'RISK',previousRouteId:'9001',previousFrom:'AAA',previousTo:'BBB',
   targetFrom:'AAA',targetTo:'CCC',targetAirportId:'300',confirmedRouteId:null,status:'outcome_unknown',mutationAuthorized:false,
   reason:'NO_RETRY_AFTER_ROUTE_MUTATION_ATTEMPT'}]};
 expect(await appendUncertainRouteMutations(directory,'company-test','777',report,now)).toBe(1);
 expect(await appendUncertainRouteMutations(directory,'company-test','777',report,now)).toBe(0);
 expect([...(await readUnresolvedRouteAircraftIds(directory,'company-test',now))]).toEqual(['9']);
 const saved=JSON.parse(await readFile(join(directory,'return-journal.json'),'utf8'));
 expect(saved.events.at(-1)).toEqual({eventId:'runc_777_9_9001_300',type:'route-uncertain',aircraftId:'9',registration:'RISK',
   previousRouteId:'9001',previousFrom:'AAA',previousTo:'BBB',targetFrom:'AAA',targetTo:'CCC',targetAirportId:'300',
   observedAt:now.toISOString(),result:'outcome_unknown',reason:'NO_RETRY_AFTER_ROUTE_MUTATION_ATTEMPT',sourceRunId:'777'});
 expect(()=>validateReturnJournal({...saved,events:[...saved.events,{...saved.events.at(-1),eventId:'runc_bad',targetFrom:'BAD!'}]},'company-test',now)).toThrow('JOURNAL_INVALID');
});


test('uncertain price save becomes durable route-wide no-retry quarantine',async()=>{
 await reviewWithReturnJournal(input(),options(),now);
 const {appendUncertainPricingMutations,readUnresolvedPricingRouteIds,validateReturnJournal}=await import('../../optimization/return-journal');
 const report:any={entries:[{aircraftId:'9',registration:'PRICE',routeId:'9001',status:'outcome_unknown',reason:'NO_RETRY_AFTER_PRICE_SAVE_ATTEMPT',
   before:{Y:1000,J:2000,F:3000},desired:{Y:1100,J:2160,F:3180},after:null}]};
 expect(await appendUncertainPricingMutations(directory,'company-test','778',report,now)).toBe(1);
 expect(await appendUncertainPricingMutations(directory,'company-test','778',report,now)).toBe(0);
 expect([...(await readUnresolvedPricingRouteIds(directory,'company-test',now))]).toEqual(['9001']);
 const saved=JSON.parse(await readFile(join(directory,'return-journal.json'),'utf8'));
 expect(saved.events.at(-1)).toMatchObject({eventId:'punc_778_9001',type:'pricing-uncertain',aircraftId:'9',routeId:'9001',
  result:'outcome_unknown',reason:'NO_RETRY_AFTER_PRICE_SAVE_ATTEMPT',sourceRunId:'778',
  before:{Y:1000,J:2000,F:3000},desired:{Y:1100,J:2160,F:3180}});
 expect(()=>validateReturnJournal({...saved,events:[...saved.events,{...saved.events.at(-1),eventId:'punc_bad',desired:{Y:-1,J:1,F:1}}]},'company-test',now)).toThrow('JOURNAL_INVALID');
});


test('gross ceiling KEEP persists truthful ceiling evidence without inventing net profit',async()=>{
 await reviewWithReturnJournal(input(),options(),now);
 const {appendVerifiedKeepRouteDecisions,validateReturnJournal}=await import('../../optimization/return-journal');
 const when=new Date('2026-10-07T20:00:00Z');
 const fleet=[{aircraftId:'1',routeId:'10',from:'GRU',to:'SCL',state:'ready',issue:null}];
 const ceiling={status:'verified_ceiling',aircraftId:'1',from:'GRU',to:'SCL',grossRevenuePerLeg:200000,grossRevenuePerHour:100000,
   source:'fresh-current-fares-capacity-direct-duration-ceiling',reason:'CURRENT_ROUTE_100_PERCENT_GROSS_REVENUE_HARD_CEILING_VERIFIED',
   comparisonReady:false,mutationAuthorized:false};
 const candidates=[{aircraftId:'1',comparisonReady:true,variableCycleComparison:{
   status:'keep_current',comparisonReady:true,comparisonBasis:'current_gross_revenue_ceiling',
   currentGrossRevenueCeiling:ceiling,current:{comparisonReady:false}
 }}];
 const decisions=[{aircraftId:'1',decision:'keep_route',selected:null,compared:1,reason:'NO_INSPECTED_CANDIDATE_PROVES_CONSERVATIVE_DOMINANCE'}];
 expect(await appendVerifiedKeepRouteDecisions(directory,'company-test',decisions,candidates,fleet,new Map([['1','GRU']]),'America/Sao_Paulo',when)).toBe(1);
 const raw=JSON.parse(await readFile(join(directory,'return-journal.json'),'utf8'));
 expect(raw.entries.at(-1).reviewEvidence.routePerformance).toEqual([{
   routeId:'10',viable:true,netProfit:null,netProfitPerHour:null,occupancyPercentages:[],grossRevenueCeilingPerHour:100000
 }]);
 expect(()=>validateReturnJournal(raw,'company-test',when)).not.toThrow();
});


test('run #1227: strictly verified ready aircraft on FIRST page resolves prior uncertainty without a global scan',async()=>{
  await reviewWithReturnJournal(input(),options(),now);
  const {
    appendUncertainDepartures,appendResolvedUncertainFromVerifiedFirstPageTarget,
    readUnresolvedDepartureKeys
  }=await import('../../optimization/return-journal');
  const prior:any={entries:[{status:'outcome_unknown',aircraftId:'9',registration:'UNCERTAIN',
    routeId:'99',from:'AAA',to:'BBB',reason:'NO_RETRY_AFTER_CLICK_ATTEMPT:CONFIRMATION_MISSING'}]};
  expect(await appendUncertainDepartures(directory,'company-test','1213',prior,now)).toBe(1);
  const at='2026-09-30T11:10:00.000Z',later=new Date('2026-09-30T11:11:00.000Z');
  const ready:any={
    aircraftId:'9',registration:'UNCERTAIN',routeId:'99',routeLabel:'AAA - BBB',
    from:'AAA',to:'BBB',state:'ready',capacity:{Y:100,J:0,F:0},
    remaining:{Y:80,J:0,F:0},dailyTotal:{Y:300,J:0,F:0},
    observedAt:at,departureControlShape:
      "Ajax('route_depart.php?id=<value>&ref=list&costIndex=<number>','routeAction',this);"
  };
  expect((await readUnresolvedDepartureKeys(directory,'company-test',later)).has('9:99')).toBe(true);
  // A first-page individual READY proof does not set global CollectionResult.complete.
  // No all-fleet collection or mutation is used by this journal-only function.
  expect(await appendResolvedUncertainFromVerifiedFirstPageTarget(directory,'company-test',
    {...ready,observedAt:now.toISOString()},later)).toBe(false);
  expect(await appendResolvedUncertainFromVerifiedFirstPageTarget(directory,'company-test',
    {...ready,registration:'OTHER'},later)).toBe(false);
  expect(await appendResolvedUncertainFromVerifiedFirstPageTarget(directory,'company-test',
    {...ready,departureControlShape:undefined},later)).toBe(false);
  expect(await appendResolvedUncertainFromVerifiedFirstPageTarget(directory,'company-test',
    {...ready,routeId:'100'},later)).toBe(false);
  expect(await appendResolvedUncertainFromVerifiedFirstPageTarget(directory,'company-test',
    {...ready,from:'CCC'},later)).toBe(false);
  expect(await appendResolvedUncertainFromVerifiedFirstPageTarget(directory,'company-test',
    {...ready,state:'inflight'},later)).toBe(false);
  expect((await readUnresolvedDepartureKeys(directory,'company-test',later)).has('9:99')).toBe(true);
  expect(await appendResolvedUncertainFromVerifiedFirstPageTarget(directory,'company-test',ready,later)).toBe(false);
  // Exactly 30 seconds is the maximum age: fresh MUST be recently observed.
  const freshTime=new Date('2026-09-30T11:10:45.000Z');
  expect(await appendResolvedUncertainFromVerifiedFirstPageTarget(directory,'company-test',
    {...ready,observedAt:freshTime.toISOString()},later)).toBe(true);
  expect((await readUnresolvedDepartureKeys(directory,'company-test',later)).has('9:99')).toBe(false);
  expect(await appendResolvedUncertainFromVerifiedFirstPageTarget(directory,'company-test',
    {...ready,observedAt:freshTime.toISOString()},later)).toBe(false);
  const saved=JSON.parse(await readFile(join(directory,'return-journal.json'),'utf8'));
  expect(saved.events.filter((e:any)=>e.type==='departure-uncertain')).toHaveLength(1);
  expect(saved.events.filter((e:any)=>e.type==='departure-uncertain-resolved')).toHaveLength(1);
  expect(saved.events.at(-1)).toMatchObject({
    type:'departure-uncertain-resolved',uncertainEventId:'unc_1213_9_99',
    liveState:'ready',result:'live_state_verified',
    reason:'STRICTLY_NEWER_VERIFIED_LIVE_STATE'
  });
});
