import type { RouteVariableCycleInterval } from './route-variable-cycle';
import { CLASSES } from '../demand/types';

export interface RouteDailyPotential {
  status:'bounded_scenario'|'unavailable';
  aircraftId:string;
  from:string;
  to:string;
  windowHours:24;
  /** No demand renewal, rest, turnarounds, scheduling constraints or re-pricing assumed. */
  maxCyclesByFlyingTime:number|null;
  maxCyclesBySharedRemainingDemand:number|null;
  theoreticalCycleCeiling:number|null;
  limitingFactor:'time'|'shared_demand'|'both'|null;
  /** Sensitivity at UNCHANGED per-cycle prices and costs, minus setup fee exactly once. */
  illustrative24hVariableProfitAfterSetup:{low:number|null;expected:number|null;high:number|null};
  reason:string;
  source:'verified-cycle-interval-static-24h-sensitivity';
  scheduleVerified:false;
  futureDemandGuaranteed:false;
  comparisonReady:false;
  mutationAuthorized:false;
}

const finite=(n:unknown):n is number=>typeof n==='number'&&Number.isFinite(n)&&Math.abs(n)<=Number.MAX_SAFE_INTEGER;
const safeCount=(n:unknown):n is number=>Number.isSafeInteger(n)&&typeof n==='number'&&n>=0;
const fresh=(stamp:string,now:Date,maxAgeSeconds:number)=>{
  const age=now.getTime()-Date.parse(stamp);
  return Number.isFinite(age)&&age>=0&&age<=maxAgeSeconds*1000;
};

/**
 * Upper *cycle-count* bound for a theoretical 24h window; NOT a timetable.
 *
 * The demand pool is shared by both directions and must sustain every cycle
 * at the empirically observed high-load requirement. Its depletion cannot be
 * replenished here; the calculation also assumes no future competitor flights.
 * Consequently even the low profit is a sensitivity estimate, NOT a lower
 * bound on realizable daily profit or permission to create a route.
 */
export function routeDailyPotential(
  cycle:RouteVariableCycleInterval,
  quoteObservedAt:string,
  now=new Date(),
  maxAgeSeconds=300
):RouteDailyPotential {
  const base:RouteDailyPotential={
    status:'unavailable',aircraftId:cycle.aircraftId,from:cycle.from,to:cycle.to,
    windowHours:24,maxCyclesByFlyingTime:null,maxCyclesBySharedRemainingDemand:null,
    theoreticalCycleCeiling:null,limitingFactor:null,
    illustrative24hVariableProfitAfterSetup:{low:null,expected:null,high:null},
    reason:'24H_SCENARIO_EVIDENCE_INCOMPLETE',
    source:'verified-cycle-interval-static-24h-sensitivity',
    scheduleVerified:false,futureDemandGuaranteed:false,comparisonReady:false,mutationAuthorized:false
  };
  const pool=cycle.demand.sharedPairRemaining;
  const required=cycle.demand.requiredForTwoLegsAtHigh;
  const p=cycle.recurringCycleProfit, first=cycle.firstCycleAfterSetup;
  if(!Number.isSafeInteger(maxAgeSeconds)||maxAgeSeconds<1||!fresh(quoteObservedAt,now,maxAgeSeconds)||
    cycle.status!=='verified_interval'||cycle.comparisonReady!==true||
    cycle.demand.competitionComplete!==true||cycle.demand.supportsTwoLegs!==true||
    !pool||!required||!finite(cycle.durationHours)||cycle.durationHours<=0||
    ![p.low,p.expected,p.high,first.low,first.expected,first.high].every(finite)||
    !(p.low!<=p.expected!&&p.expected!<=p.high!)||
    !CLASSES.every(k=>safeCount(pool[k])&&safeCount(required[k])&&required[k]<=pool[k]))
    return base;

  // A positive consumption in at least one class is essential. Missing seat
  // occupancy evidence must never turn into "unlimited demand".
  const active=CLASSES.filter(k=>required[k]>0);
  if(!active.length)return base;
  const maxCyclesByFlyingTime=Math.floor(24/cycle.durationHours);
  const maxCyclesBySharedRemainingDemand=Math.min(...active.map(k=>Math.floor(pool[k]/required[k])));
  if(!safeCount(maxCyclesByFlyingTime)||!safeCount(maxCyclesBySharedRemainingDemand)||
    maxCyclesByFlyingTime<1||maxCyclesBySharedRemainingDemand<1)
    return {...base,reason:'NO_COMPLETE_CYCLE_IN_24H_WITH_STATIC_DEMAND'};

  // First-cycle difference must agree in all interval components; the route
  // creation fee is charged once for the hypothetical daily window.
  const fees=[p.low!-first.low!,p.expected!-first.expected!,p.high!-first.high!];
  if(!fees.every(finite)||fees.some(x=>x<0)||
    Math.max(...fees)-Math.min(...fees)>Math.max(0.000001,Math.abs(fees[0])*0.000000001))
    return {...base,reason:'INCONSISTENT_SETUP_FEE'};
  const setupFee=fees[0];
  const count=Math.min(maxCyclesByFlyingTime,maxCyclesBySharedRemainingDemand);
  const low=count*p.low!-setupFee,expected=count*p.expected!-setupFee,high=count*p.high!-setupFee;
  if(![low,expected,high].every(finite))
    return {...base,reason:'24H_SCENARIO_NUMERIC_OVERFLOW'};

  return {...base,status:'bounded_scenario',
    maxCyclesByFlyingTime,maxCyclesBySharedRemainingDemand,theoreticalCycleCeiling:count,
    limitingFactor:maxCyclesByFlyingTime===maxCyclesBySharedRemainingDemand?'both':
      maxCyclesByFlyingTime<maxCyclesBySharedRemainingDemand?'time':'shared_demand',
    illustrative24hVariableProfitAfterSetup:{low,expected,high},
    reason:'STATIC_24H_UPPER_CYCLE_COUNT_WITH_FIXED_COST_SENSITIVITY_NOT_REALIZED_PROFIT'};
}

export interface RouteDailyOpportunityRank {
  rank:number;
  aircraftId:string;
  from:string;
  to:string;
  theoreticalCycleCeiling:number;
  illustrative24hProfitLow:number;
  illustrative24hProfitExpected:number;
  /** Always diagnostic; never substitute for the conservative reroute gate. */
  comparisonReady:false;
  mutationAuthorized:false;
}

/** Rank only the verified-scenario subset for each aircraft; not a global route recommendation. */
export function rankDailyRouteScenarios<T extends {dailyPotential:RouteDailyPotential}>(rows:readonly T[]):RouteDailyOpportunityRank[]{
  const ordered=rows.filter(row=>
    row.dailyPotential.status==='bounded_scenario'&&
    finite(row.dailyPotential.illustrative24hVariableProfitAfterSetup.low)&&
    finite(row.dailyPotential.illustrative24hVariableProfitAfterSetup.expected)&&
    safeCount(row.dailyPotential.theoreticalCycleCeiling) &&
    row.dailyPotential.theoreticalCycleCeiling!>0
  ).slice().sort((a,b)=>
    a.dailyPotential.aircraftId.localeCompare(b.dailyPotential.aircraftId,undefined,{numeric:true})||
    b.dailyPotential.illustrative24hVariableProfitAfterSetup.low!-a.dailyPotential.illustrative24hVariableProfitAfterSetup.low!||
    b.dailyPotential.illustrative24hVariableProfitAfterSetup.expected!-a.dailyPotential.illustrative24hVariableProfitAfterSetup.expected!||
    a.dailyPotential.to.localeCompare(b.dailyPotential.to)
  );
  let previous='',rank=0;
  return ordered.map(({dailyPotential:d})=>{
    if(d.aircraftId!==previous){rank=0;previous=d.aircraftId;}
    return {rank:++rank,aircraftId:d.aircraftId,from:d.from,to:d.to,
      theoreticalCycleCeiling:d.theoreticalCycleCeiling!,
      illustrative24hProfitLow:d.illustrative24hVariableProfitAfterSetup.low!,
      illustrative24hProfitExpected:d.illustrative24hVariableProfitAfterSetup.expected!,
      comparisonReady:false,mutationAuthorized:false};
  });
}
