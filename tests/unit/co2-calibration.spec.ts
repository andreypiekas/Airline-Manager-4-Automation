import { test, expect } from '@playwright/test';
import type { AircraftSnapshot } from '../../demand/types';
import type { CandidateQuote } from '../../optimization/quote-reader';
import type { RouteCatalog } from '../../optimization/reference-data';
import { calibrateCo2FromFlightHistory, estimateObservedCo2Quotas } from '../../optimization/co2-calibration';

const now=new Date('2026-10-02T20:00:00Z');
const stamp=now.toISOString();
const distance=2615;
const factor=.16;
const fixed=.081;

function history(Y:number,J:number,F:number,from='GRU',to='SCL'){
  const weighted=Y+2*J+3*F;
  return {
    relativeTime:'1 hour ago',from,to,registrationLabel:'MC-21-400',
    co2Quotas:Math.round(distance*(factor*weighted+fixed)),
    onboard:{Y,J,F},fuelLbs:51176,revenue:100000
  };
}
function aircraft(entries= [
  history(120,4,3),
  history(117,4,3,'SCL','GRU'),
  history(0,6,4),
  history(100,10,1,'SCL','GRU'),
  history(0,0,0)
]):AircraftSnapshot{
  return {
    aircraftId:'1',registration:'MC-21-400',routeId:'10',routeLabel:'GRU-SCL',
    from:'GRU',to:'SCL',state:'ready',capacity:{Y:180,J:20,F:10},
    remaining:{Y:100,J:10,F:5},dailyTotal:{Y:200,J:20,F:10},observedAt:stamp,
    flightHistory:{
      status:'observed',observedAt:stamp,source:'inspected-aircraft-flight-history',
      complete:false,entries,comparisonReady:false,mutationAuthorized:false
    }
  };
}
function quote(co2=factor,to='AAA'):CandidateQuote{
  return {
    aircraftId:'1',registration:'MC-21-400',airportId:to==='AAA'?'100':'101',
    from:'GRU',to,observedAt:stamp,distanceKm:1000,durationSeconds:4000,fuelLbs:20000,
    co2KgPerPaxKm:co2,costIndex:200,routeFee:10000,aircraftOnRoute:0,
    dailyDemand:{Y:500,J:100,F:50},autopriceReference:null,
    remainingDemand:null,netProfit:null,comparisonReady:false,mutationAuthorized:false
  };
}
function catalog(extra:RouteCatalog['routes']=[]):RouteCatalog{
  return {schemaVersion:1,source:'synthetic',sha256:'x',routes:[
    {from:'GRU',to:'SCL',distanceKm:distance,referenceDemand:{Y:1,J:1,F:1},sourceRow:1},
    ...extra
  ]};
}

test('verifies weighted cabin-unit CO2 formula from multiple observed mixes',()=>{
  const r=calibrateCo2FromFlightHistory(aircraft(),[quote()],catalog(),now);
  expect(r.status).toBe('verified_weighted_cabin_units');
  expect(r.formulaVerified).toBe(true);
  expect(r.quoteFactor).toBe(factor);
  expect(r.calibratedFactorPerUnit).toBeCloseTo(factor,4);
  expect(r.fixedQuotasPerKm).toBeCloseTo(fixed,3);
  expect(r.samples).toHaveLength(5);
  expect(r.weightedResidualSpread).toBeLessThanOrEqual(.025);
  expect(r.physicalResidualSpread).toBeGreaterThan(r.weightedResidualSpread!+.05);
  expect(r.comparisonReady).toBe(false);
  expect(r.mutationAuthorized).toBe(false);
});

test('all-economy history cannot distinguish physical from weighted cabin units',()=>{
  const entries=[history(100,0,0),history(80,0,0),history(60,0,0),history(40,0,0)];
  const r=calibrateCo2FromFlightHistory(aircraft(entries),[quote(),quote(factor,'BBB')],catalog(),now);
  expect(r.status).toBe('insufficient');
  expect(r.formulaVerified).toBe(false);
  expect(r.reason).toBe('PREMIUM_CABIN_MIX_INSUFFICIENT_TO_DISTINGUISH_FORMULA');
});

test('economy-only aircraft verifies quota prediction by mathematical cabin equivalence',()=>{
  const entries=[
    history(12,0,0),history(11,0,0,'SCL','GRU'),history(10,0,0),history(8,0,0,'SCL','GRU')
  ];
  const a=aircraft(entries);
  a.capacity={Y:12,J:0,F:0};
  a.remaining={Y:12,J:0,F:0};
  a.dailyTotal={Y:100,J:0,F:0};
  const r=calibrateCo2FromFlightHistory(a,[quote()],catalog(),now);
  expect(r.status).toBe('verified_single_cabin_equivalence');
  expect(r.formulaVerified).toBe(true);
  expect(r.reason).toBe('LIVE_HISTORY_SUPPORTS_ECONOMY_ONLY_EQUIVALENT_FORMULA_WITH_STABLE_PER_KM_INTERCEPT');
  expect(estimateObservedCo2Quotas(r,1000,{Y:12,J:0,F:0})).not.toBeNull();
});
test('conflicting live quote factors fail closed',()=>{
  const r=calibrateCo2FromFlightHistory(aircraft(),[quote(.16),quote(.17,'BBB')],catalog(),now);
  expect(r.status).toBe('inconsistent');
  expect(r.formulaVerified).toBe(false);
  expect(r.reason).toBe('LIVE_QUOTE_CO2_FACTOR_CONFLICT');
});

test('reciprocal catalogue rows with identical verified distance remain usable',()=>{
  const duplicate={from:'SCL',to:'GRU',distanceKm:distance,referenceDemand:{Y:1,J:1,F:1},sourceRow:2};
  const r=calibrateCo2FromFlightHistory(aircraft(),[quote(),quote(factor,'BBB')],catalog([duplicate]),now);
  expect(r.status).toBe('verified_weighted_cabin_units');expect(r.samples).toHaveLength(5);
});
test('conflicting route catalogue distances still fail closed',()=>{
  const conflict={from:'SCL',to:'GRU',distanceKm:distance+1,referenceDemand:{Y:1,J:1,F:1},sourceRow:2};
  const r=calibrateCo2FromFlightHistory(aircraft(),[quote(),quote(factor,'BBB')],catalog([conflict]),now);
  expect(r.status).toBe('insufficient');expect(r.samples).toHaveLength(0);expect(r.reason).toBe('TOO_FEW_RESOLVED_HISTORY_SAMPLES');
});

test('verified evidence estimates quota use but unavailable evidence never does',()=>{
  const r=calibrateCo2FromFlightHistory(aircraft(),[quote(),quote(factor,'BBB')],catalog(),now);
  expect(estimateObservedCo2Quotas(r,1000,{Y:100,J:5,F:2})).toBe(
    Math.round(1000*(r.fixedQuotasPerKm!+r.calibratedFactorPerUnit!*(100+10+6)))
  );
  expect(estimateObservedCo2Quotas({...r,formulaVerified:false},1000,{Y:100,J:5,F:2})).toBeNull();
  expect(estimateObservedCo2Quotas(r,-1,{Y:100,J:5,F:2})).toBeNull();
});

test('rounded live factor is refined only by stable observed history inside its display interval',()=>{
 const displayed=.17,actual=.17006534,fixedObserved=.05009575;
 const entries=[0,11,68,75,91,101,112,117].map((Y,i)=>({relativeTime:'1 hour ago',from:i%2?'GRU':'SCL',to:i%2?'SCL':'GRU',registrationLabel:'B727',co2Quotas:Math.round(distance*(actual*Y+fixedObserved)),onboard:{Y,J:0,F:0},fuelLbs:1,revenue:Y*1000}));
 const a=aircraft(entries);a.registration='B727';a.capacity={Y:131,J:0,F:0};a.remaining={Y:20,J:0,F:0};a.dailyTotal={Y:200,J:0,F:0};
 const live=quote(displayed);live.registration='B727';
 const r=calibrateCo2FromFlightHistory(a,[live],catalog(),now);
 expect(r.status).toBe('verified_single_cabin_equivalence');expect(r.formulaVerified).toBe(true);expect(r.quoteFactor).toBe(displayed);expect(r.calibratedFactorPerUnit).toBeCloseTo(actual,4);expect(r.fixedQuotasPerKm).toBeCloseTo(fixedObserved,3);
});
test('recent eight consecutive flights corroborate a changed CO2 policy without using stale historical model',()=>{
 const loads:Array<[number,number,number]>=[
  [120,4,3],[117,4,3],[0,6,4],[100,10,1],[90,1,2],[115,5,3],[80,8,2],[95,1,5],
  [120,4,3],[117,4,3],[0,6,4],[100,10,1],[90,1,2],[115,5,3]
 ];
 const entries=loads.map(([Y,J,F],i)=>{
   const current=i<8?factor:.12;
   const h=history(Y,J,F,i%2?'SCL':'GRU',i%2?'GRU':'SCL');
   return {...h,relativeTime:(i<8?i+1:i+7)+' hours ago',
     co2Quotas:Math.round(distance*(current*(Y+2*J+3*F)+fixed))};
 });
 const a=aircraft(entries);
 const r=calibrateCo2FromFlightHistory(a,[quote()],catalog(),now);
 expect(r).toMatchObject({
   status:'verified_weighted_cabin_units',formulaVerified:true,
   fitScope:'recent_consecutive_eight',fitSamplesUsed:8,
   reason:'EIGHT_NEWEST_CONSECUTIVE_FLIGHTS_AGREE_WITH_LIVE_QUOTE_FACTOR',
   mutationAuthorized:false
 });
 expect(r.samples).toHaveLength(14);
 expect(r.calibratedFactorPerUnit).toBeCloseTo(factor,4);
});

test('recent-history fallback refuses stale, gapped or conflicting observations',()=>{
 const mixes:Array<[number,number,number]>=[
  [120,4,3],[117,4,3],[0,6,4],[100,10,1],[90,1,2],[115,5,3],[80,8,2],[95,1,5],
  [120,4,3],[117,4,3]
 ];
 const entries=mixes.map(([Y,J,F],i)=>({
   ...history(Y,J,F),relativeTime:(i+1)+' hours ago',
   co2Quotas:Math.round(distance*((i<8?factor:.12)*(Y+2*J+3*F)+fixed))
 }));
 const a=aircraft(entries);
 const different=quote(.15);
 expect(calibrateCo2FromFlightHistory(a,[different],catalog(),now).formulaVerified).toBe(false);
 const late=aircraft(entries.map((x,i)=>({...x,relativeTime:(i+30)+' hours ago'})));
 expect(calibrateCo2FromFlightHistory(late,[quote()],catalog(),now).formulaVerified).toBe(false);
 const skipped=aircraft(entries.map((x,i)=>i===0?{...x,from:'ZZZ',to:'XXX'}:x));
 expect(calibrateCo2FromFlightHistory(skipped,[quote()],catalog(),now).formulaVerified).toBe(false);
});
test('history slope outside live displayed-factor rounding remains fail closed',()=>{
 const entries=[10,30,60,90].map(Y=>history(Y,0,0));const a=aircraft(entries);a.capacity={Y:100,J:0,F:0};
 const r=calibrateCo2FromFlightHistory(a,[quote(.17)],catalog(),now);expect(r.formulaVerified).toBe(false);expect(r.reason).toBe('HISTORICAL_FACTOR_OUTSIDE_LIVE_DISPLAY_ROUNDING');
});
