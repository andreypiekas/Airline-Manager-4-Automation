import { test,expect } from '@playwright/test';
import { planVariableRouteDecision, routeDecisionSetComparisonReady, RouteDecisionCandidate } from '../../optimization/route-decision';

const candidate=(to:string,low:number,status:'candidate_dominates'|'keep_current'='candidate_dominates',control=true):RouteDecisionCandidate=>({
  aircraftId:'101',from:'GRU',to,airportId:to==='AAA'?'1':to==='BBB'?'2':'3',
  comparisonReady:true,
  variableCycleComparison:{status,comparisonReady:true},
  candidateVariableCycle:{
    status:'verified_interval',
    recurringCycleProfitPerHour:{low,expected:low+100,high:low+200},
    firstCycleAfterSetup:{low:low*2,expected:low*2+100,high:low*2+200}
  },
  routeMutationControl:control?{
    nativeClickReady:true,endpointVerified:true,targetVerified:true,
    aircraftIdMatchesContext:true,airportIdMatchesContext:true
  }:null
});

test('selects highest conservative low bound among verified dominating candidates',()=>{
  const r=planVariableRouteDecision('101',[candidate('AAA',1000),candidate('BBB',1500),candidate('CCC',1200)]);
  expect(r).toMatchObject({
    decision:'would_reroute',compared:3,dominating:3,
    selected:{from:'GRU',to:'BBB',airportId:'2',conservativeProfitPerHour:1500},
    mutationAuthorized:false
  });
});

test('keeps route when no inspected candidate proves conservative dominance',()=>{
  const r=planVariableRouteDecision('101',[candidate('AAA',1000,'keep_current'),candidate('BBB',1200,'keep_current')]);
  expect(r).toMatchObject({decision:'keep_route',compared:2,dominating:0,selected:null});
});

test('dominant economics without verified native target stays HOLD, never KEEP',()=>{
  const r=planVariableRouteDecision('101',[candidate('AAA',1000,'candidate_dominates',false)]);
  expect(r).toMatchObject({decision:'hold',compared:1,dominating:1,selected:null,
    reason:'BEST_DOMINANT_CANDIDATE_MUTATION_CONTROL_UNVERIFIED',mutationAuthorized:false});
});

test('incomplete comparison set fails closed',()=>{
  const c=candidate('AAA',1000);c.comparisonReady=false;
  expect(planVariableRouteDecision('101',[c])).toMatchObject({decision:'hold',reason:'NO_VERIFIED_VARIABLE_CYCLE_COMPARISON'});
  expect(planVariableRouteDecision('bad',[c])).toMatchObject({decision:'unavailable'});
});


test('valid but incomplete comparison stays as explicit retryable HOLD',()=>{
  const c=candidate('AAA',1000);c.comparisonReady=false;
  const r=planVariableRouteDecision('101',[c]);
  expect(r).toMatchObject({decision:'hold',selected:null,compared:0,dominating:0,reason:'NO_VERIFIED_VARIABLE_CYCLE_COMPARISON',mutationAuthorized:false});
});


test('aggregate route comparison readiness requires every inspected decision to be complete',()=>{
  const c=candidate('AAA',1000);c.comparisonReady=false;
  const hold=planVariableRouteDecision('101',[c]);
  expect(hold.decision).toBe('hold');
  expect(routeDecisionSetComparisonReady([])).toBe(false);
  expect(routeDecisionSetComparisonReady([hold])).toBe(false);
  expect(routeDecisionSetComparisonReady([{...hold,decision:'unavailable'}])).toBe(false);
  expect(routeDecisionSetComparisonReady([{...hold,decision:'keep_route'}])).toBe(false);
  expect(routeDecisionSetComparisonReady([{...hold,candidateSetComplete:true,decision:'keep_route'}])).toBe(true);
  expect(routeDecisionSetComparisonReady([{...hold,decision:'would_reroute'}])).toBe(false);
  expect(routeDecisionSetComparisonReady([{...hold,candidateSetComplete:true,decision:'would_reroute'}])).toBe(true);
  expect(routeDecisionSetComparisonReady([
    {...hold,aircraftId:'101',decision:'keep_route'},
    {...hold,aircraftId:'102',decision:'hold'}
  ])).toBe(false);
  expect(routeDecisionSetComparisonReady([
    {...hold,aircraftId:'101',decision:'keep_route',candidateSetComplete:true},
    {...hold,aircraftId:'102',decision:'would_reroute',candidateSetComplete:true}
  ])).toBe(true);
});


test('partially verified candidate set stays HOLD instead of prematurely KEEP or REROUTE',()=>{
  const ready=candidate('AAA',1000,'keep_current');
  const incomplete=candidate('BBB',1500,'candidate_dominates');incomplete.comparisonReady=false;
  const r=planVariableRouteDecision('101',[ready,incomplete]);
  expect(r).toMatchObject({decision:'hold',compared:1,dominating:0,selected:null,
    reason:'INCOMPLETE_VERIFIED_CANDIDATE_COMPARISON_SET',mutationAuthorized:false});
});

test('one independently verified dominant alternative may improve current route even if other probes are incomplete',()=>{
  const winner=candidate('AAA',1300);
  const unverified=candidate('BBB',10000);unverified.comparisonReady=false;
  const result=planVariableRouteDecision('101',[winner,unverified]);
  expect(result).toMatchObject({
    decision:'would_reroute',selected:{from:'GRU',to:'AAA',airportId:'1'},
    compared:1,dominating:1,candidateSetComplete:false,
    reason:'PROVEN_CONSERVATIVE_IMPROVEMENT_WITH_PARTIAL_CANDIDATE_SET',
    dryRun:true,mutationAuthorized:false
  });
  expect(routeDecisionSetComparisonReady([result])).toBe(false);
  expect(unverified.comparisonReady).toBe(false);
});

test('partial set never authorizes a speculative improvement or a premature keep',()=>{
  const unready=candidate('BBB',100000);unready.comparisonReady=false;
  const notBetter=candidate('AAA',1000,'keep_current');
  const hold=planVariableRouteDecision('101',[notBetter,unready]);
  expect(hold).toMatchObject({decision:'hold',selected:null,
    candidateSetComplete:false,reason:'INCOMPLETE_VERIFIED_CANDIDATE_COMPARISON_SET'});
  const incompleteControl=candidate('AAA',1000,'candidate_dominates',false);
  const blocked=planVariableRouteDecision('101',[incompleteControl,unready]);
  expect(blocked).toMatchObject({decision:'hold',selected:null,candidateSetComplete:false,
    reason:'BEST_DOMINANT_CANDIDATE_MUTATION_CONTROL_UNVERIFIED'});
});

test('best economic dominant must itself have native mutation evidence',()=>{
  const best=candidate('BBB',1500,'candidate_dominates',false);
  const second=candidate('AAA',1200,'candidate_dominates',true);
  const r=planVariableRouteDecision('101',[best,second]);
  expect(r).toMatchObject({decision:'hold',compared:2,dominating:2,selected:null,
    reason:'BEST_DOMINANT_CANDIDATE_MUTATION_CONTROL_UNVERIFIED'});
});
