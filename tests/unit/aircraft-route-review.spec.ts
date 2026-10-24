import { test,expect } from '@playwright/test';
import type { AircraftSnapshot,CollectionResult } from '../../demand/types';
import { buildAircraftRouteReview,observeCurrentRouteHistory,type AircraftRouteReviewInput } from '../../optimization/aircraft-route-review';

const now=new Date('2026-10-24T17:00:00Z'),stamp=now.toISOString();
const ac=(id='101'):AircraftSnapshot=>({
 aircraftId:id,registration:'AC-'+id,routeId:id,routeLabel:'GRU-SCL',from:'GRU',to:'SCL',
 state:'ready',capacity:{Y:140,J:10,F:2},onboard:null,remaining:{Y:500,J:30,F:10},
 dailyTotal:{Y:550,J:40,F:15},observedAt:stamp,operational:{cycles:35} as any,
 flightHistory:{status:'observed',observedAt:stamp,complete:false,source:'inspected-aircraft-flight-history',
  comparisonReady:false,mutationAuthorized:false,entries:[
    {relativeTime:'2 hours ago',from:'GRU',to:'SCL',registrationLabel:'AC-101',onboard:{Y:100,J:8,F:1},
      fuelLbs:10000,co2Quotas:2000,revenue:200000},
    {relativeTime:'3 hours ago',from:'SCL',to:'GRU',registrationLabel:'AC-101',onboard:{Y:110,J:9,F:1},
      fuelLbs:12000,co2Quotas:2200,revenue:220000},
    {relativeTime:'4 hours ago',from:'GRU',to:'LIM',registrationLabel:'AC-101',onboard:{Y:110,J:9,F:1},
      fuelLbs:30000,co2Quotas:5000,revenue:300000},
  ]}
});
const market={fuel:{commodity:'fuel' as const,unit:'lbs' as const,pricePer1000:800,observedAt:stamp,
  source:'inspected-market' as const,inventoryAcquisitionPrice:null},
 co2:{commodity:'co2' as const,unit:'quotas' as const,pricePer1000:100,observedAt:stamp,
  source:'inspected-market' as const,inventoryAcquisitionPrice:null}};
test('current route review uses ONLY own pair flight history, live replacement prices and NEVER declares net profit',()=>{
 const item=ac();
 const value=observeCurrentRouteHistory(item,market,now);
 expect(value).toMatchObject({sampleCount:2,grossRevenuePerFlight:210000,fuelLbsPerFlight:11000,
  co2QuotasPerFlight:2100,fuelReplacementCostPerFlight:8800,co2ReplacementCostPerFlight:210,
  grossLessFuelCo2ReplacementPerFlight:200990,profitNotProven:true});
 expect(observeCurrentRouteHistory(item,{...market,co2:null},now).grossLessFuelCo2ReplacementPerFlight).toBeNull();
 const old={...item,observedAt:new Date(now.getTime()-3600000).toISOString()};
 expect(observeCurrentRouteHistory(old,market,now).sampleCount).toBe(0);
});

test('per-aircraft calculator review distinguishes unexamined, unresolved, keep and independently proven switch',()=>{
 const collection:CollectionResult={complete:true,expectedRoutes:4,warnings:[],aircraft:[ac('101'),ac('102'),ac('103'),ac('104')]};
 const candidates=[{
  aircraftId:'102',from:'GRU',to:'LIM',variableCycleComparison:{status:'unavailable',comparisonReady:false},
  candidateVariableCycle:{status:'unavailable',recurringCycleProfitPerHour:{low:null,expected:null,high:null}}
 },{
  aircraftId:'104',from:'GRU',to:'MIA',variableCycleComparison:{status:'candidate_dominates',comparisonReady:true},
  candidateVariableCycle:{status:'verified_interval',recurringCycleProfitPerHour:{low:5000,expected:8000,high:10000}}
 }];
 const analysis:AircraftRouteReviewInput['analysis']={
  candidates,market,routeDecisions:[
   {aircraftId:'102',decision:'hold',compared:0,dominating:0,candidateSetComplete:false,
    selected:null,reason:'NO_VERIFIED_VARIABLE_CYCLE_COMPARISON'},
   {aircraftId:'103',decision:'keep_route',compared:2,dominating:0,candidateSetComplete:true,
    selected:null,reason:'NO_INSPECTED_CANDIDATE_PROVES_CONSERVATIVE_DOMINANCE'},
   {aircraftId:'104',decision:'would_reroute',compared:1,dominating:1,candidateSetComplete:false,
    selected:{from:'GRU',to:'MIA',airportId:'123',conservativeProfitPerHour:5000,firstCycleLow:15000},
    reason:'PROVEN_CONSERVATIVE_IMPROVEMENT_WITH_PARTIAL_CANDIDATE_SET'}
  ]
 };
 const report=buildAircraftRouteReview({collection,analysis,research:{aircraft:[
  {aircraftId:'102',status:'observed',result:{quotes:[{}],screenedOut:[]}},
  {aircraftId:'103',status:'observed',result:{quotes:[{},{}],screenedOut:[]}},
  {aircraftId:'104',status:'partial',result:{quotes:[{}],screenedOut:[]}}
 ]}},now);
 expect(report.summary).toEqual({aircraft:4,switchProposed:1,keepVerified:1,awaitingEvidence:1,pendingResearch:1});
 expect(report.aircraft.map(x=>x.verdict)).toEqual([
  'pending_research','awaiting_economic_evidence','keep_among_verified_comparisons','switch_proposed'
 ]);
 expect(report.aircraft[3]).toMatchObject({
  comparisonSetComplete:false,globallyBestProven:false,
  proposedRoute:{from:'GRU',to:'MIA',conservativeProfitPerHour:5000},mutationAuthorized:false
 });
 const weakened={...analysis,candidates:candidates.map(c=>c.aircraftId==='104'?
  {...c,variableCycleComparison:{status:'unavailable',comparisonReady:false}}:c)};
 expect(buildAircraftRouteReview({collection,analysis:weakened,research:{aircraft:[]}},now).aircraft[3].proposedRoute).toBeNull();
});

test('a historical current-route measure never certifies a global optimum or creates an automatic change',()=>{
 const collection:CollectionResult={complete:false,expectedRoutes:2,warnings:[],aircraft:[ac()]};
 const report=buildAircraftRouteReview({collection,analysis:{candidates:[],routeDecisions:[],market},
  research:{aircraft:[]}},now);
 expect(report).toMatchObject({fleetComplete:false,comparisonReady:false,mutationAuthorized:false});
 expect(report.aircraft[0]).toMatchObject({globallyBestProven:false,verdict:'pending_research',proposedRoute:null});
});
