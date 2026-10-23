import { expect, test } from '@playwright/test';
import type { RouteVariableCycleInterval } from '../../optimization/route-variable-cycle';
import { rankDailyRouteScenarios, routeDailyPotential } from '../../optimization/route-daily-potential';

const now=new Date('2026-10-23T12:00:00.000Z');
const stamp=now.toISOString();
const verified={
  status:'verified_interval',aircraftId:'101',from:'GRU',to:'BSB',comparisonReady:true,
  durationHours:6,
  demand:{
    sharedPairRemaining:{Y:1050,J:35,F:0},
    requiredForTwoLegsAtHigh:{Y:200,J:10,F:0},
    supportsTwoLegs:true,competitionComplete:true
  },
  recurringCycleProfit:{low:100,expected:200,high:300},
  firstCycleAfterSetup:{low:80,expected:180,high:280}
} as RouteVariableCycleInterval;

test('theoretical cycles capped by full ida/volta duration and shared demand, fee charged once',()=>{
  const p=routeDailyPotential(verified,stamp,now);
  expect(p).toMatchObject({
    status:'bounded_scenario',maxCyclesByFlyingTime:4,
    maxCyclesBySharedRemainingDemand:3,theoreticalCycleCeiling:3,
    limitingFactor:'shared_demand',
    illustrative24hVariableProfitAfterSetup:{low:280,expected:580,high:880},
    scheduleVerified:false,futureDemandGuaranteed:false,comparisonReady:false,mutationAuthorized:false
  });
});

test('time can be the binding 24h ceiling; exact time allowance uses full cycles',()=>{
  const p=routeDailyPotential({...verified,
    demand:{...verified.demand,sharedPairRemaining:{Y:2000,J:100,F:0}}
  },stamp,now);
  expect(p).toMatchObject({status:'bounded_scenario',limitingFactor:'time',
    maxCyclesByFlyingTime:4,maxCyclesBySharedRemainingDemand:10,theoreticalCycleCeiling:4,
    illustrative24hVariableProfitAfterSetup:{low:380,expected:780,high:1180}});
  expect(routeDailyPotential({...verified,durationHours:24},stamp,now).theoreticalCycleCeiling).toBe(1);
  expect(routeDailyPotential({...verified,durationHours:24.01},stamp,now).status).toBe('unavailable');
});

test('missing, stale or competing-demand-incomplete evidence fails closed',()=>{
  const baseline=routeDailyPotential(verified,stamp,now);
  const cases:RouteVariableCycleInterval[]=[
    {...verified,status:'unavailable'},
    {...verified,comparisonReady:false},
    {...verified,demand:{...verified.demand,competitionComplete:false}},
    {...verified,demand:{...verified.demand,supportsTwoLegs:false}},
    {...verified,demand:{...verified.demand,sharedPairRemaining:null}},
    {...verified,demand:{...verified.demand,requiredForTwoLegsAtHigh:null}},
    {...verified,demand:{...verified.demand,requiredForTwoLegsAtHigh:{Y:0,J:0,F:0}}},
    {...verified,demand:{...verified.demand,sharedPairRemaining:{Y:199,J:35,F:0}}},
    {...verified,durationHours:0},
    {...verified,recurringCycleProfit:{low:300,expected:200,high:400}},
    {...verified,firstCycleAfterSetup:{low:80,expected:170,high:280}}
  ];
  for(const c of cases) expect(routeDailyPotential(c,stamp,now).status).toBe('unavailable');
  expect(routeDailyPotential(verified,new Date(now.getTime()-301000).toISOString(),now).status).toBe('unavailable');
  expect(routeDailyPotential(verified,new Date(now.getTime()+1000).toISOString(),now).status).toBe('unavailable');
  expect(baseline.mutationAuthorized).toBe(false);
});

test('grouped reference ranking does not modify existing route decisions',()=>{
  const a=routeDailyPotential(verified,stamp,now);
  const b=routeDailyPotential({...verified,to:'GIG',
    recurringCycleProfit:{low:200,expected:300,high:400},
    firstCycleAfterSetup:{low:180,expected:280,high:380}},stamp,now);
  const other=routeDailyPotential({...verified,aircraftId:'202',to:'XAP'},stamp,now);
  const result=rankDailyRouteScenarios([{dailyPotential:a},{dailyPotential:b},
    {dailyPotential:other},{dailyPotential:routeDailyPotential({...verified,status:'unavailable'},stamp,now)}]);
  expect(result.map(x=>[x.aircraftId,x.rank,x.to])).toEqual([
    ['101',1,'GIG'],['101',2,'BSB'],['202',1,'XAP']
  ]);
  expect(result.every(x=>x.comparisonReady===false&&x.mutationAuthorized===false)).toBe(true);
});
