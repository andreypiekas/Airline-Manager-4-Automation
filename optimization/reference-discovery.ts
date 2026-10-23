import type { AircraftSnapshot, Cabins, CollectionResult } from '../demand/types';
import { communityRoutePriceScenarios, type CommunityRoutePriceScenarios } from './community-route-prices';
import type { AirportCatalog, AirportReference, RouteCatalog, ReferenceRoute } from './reference-data';

export interface CatalogDiscoveryCandidate {
  from:string;to:string;distanceKm:number;
  sourceRow:number;referenceDemand:Cabins;
  /** Mode-agnostic static gross ceiling; NOT expected revenue, margin or daily profit. */
  minTheoreticalGrossAcrossModes:number;
  referenceSeatCoveragePercent:number;
  theoreticalFares:CommunityRoutePriceScenarios;
  sameAirportPairAsCurrentRoute:boolean;
  runwaySource:'airport-catalog-reference';
  demandSource:'curated-static-route-catalog';
  remainingDemand:null;netProfit:null;comparisonReady:false;mutationAuthorized:false;
}

export interface CatalogOriginCoverage {
  origin:string;listedRows:number;distinctDestinations:number;
  unlistedDestinationsUnknown:true;
  source:'curated-route-catalog-not-global';
}

export interface CatalogAircraftDiscovery {
  aircraftId:string;registration:string;origin:string|null;
  status:'ranked_reference'|'no_verified_reference_candidates'|'unavailable';
  examinedRows:number;
  eligibleRowsBeforeLimit:number;
  excluded:{conflictedOrDuplicate:number;invalidReference:number;outOfRange:number;runwayUnknown:number;runwayTooShort:number;noDemandOrFareEvidence:number};
  ranked:CatalogDiscoveryCandidate[];
  reason:string;
  source:'curated-route-catalog-not-global';
  exhaustiveSearch:false;comparisonReady:false;mutationAuthorized:false;
}

export interface CatalogDiscoveryReport {
  source:string;sourceSha256:string;
  referenceRows:number;
  coverage:CatalogOriginCoverage[];
  aircraft:CatalogAircraftDiscovery[];
  rankedAcrossBases:false;
  catalogGlobalCoverageProven:false;
  authoritativeDemand:false;
  liveRouteValidationRequired:true;
  comparisonReady:false;mutationAuthorized:false;
  warnings:string[];
}

const code=(s:unknown):s is string=>typeof s==='string'&&/^[A-Z]{3}$/.test(s);
const goodSeats=(v:unknown):v is Cabins=>v!==null&&typeof v==='object'&&
  ['Y','J','F'].every(k=>Number.isSafeInteger((v as Record<string,number>)[k])&&(v as Record<string,number>)[k]>=0);
const pair=(from:string,to:string)=>[from,to].sort().join('|');
const safeAirport=(data:AirportCatalog|null,codeValue:string):AirportReference|null=>{
  if(!data||![1,2].includes(data.schemaVersion)||!Array.isArray(data.airports)||!code(codeValue))return null;
  const matches=data.airports.filter(a=>a.iata===codeValue&&!a.conflict&&Number.isSafeInteger(a.runwayFt)&&a.runwayFt!>0);
  return matches.length===1?matches[0]:null;
};
const validRoute=(r:ReferenceRoute)=>code(r.from)&&code(r.to)&&r.from!==r.to&&
  Number.isFinite(r.distanceKm)&&r.distanceKm>=100&&r.distanceKm<=20050&&
  Number.isSafeInteger(r.sourceRow)&&r.sourceRow>0&&goodSeats(r.referenceDemand);
const fresh=(s:string,now:Date,maxAge:number)=>{
  const diff=now.getTime()-Date.parse(s);
  return Number.isFinite(diff)&&diff>=0&&diff<=maxAge*1000;
};
const untrusted=(a:AircraftSnapshot,origin:string|null):CatalogAircraftDiscovery=>({
  aircraftId:a.aircraftId,registration:a.registration,origin,status:'unavailable',examinedRows:0,eligibleRowsBeforeLimit:0,
  excluded:{conflictedOrDuplicate:0,invalidReference:0,outOfRange:0,runwayUnknown:0,runwayTooShort:0,noDemandOrFareEvidence:0},
  ranked:[],reason:'AIRCRAFT_ORIGIN_OR_CURRENT_SNAPSHOT_UNVERIFIED',
  source:'curated-route-catalog-not-global',
  exhaustiveSearch:false,comparisonReady:false,mutationAuthorized:false
});

/**
 * Read-only catalog discovery *independent of the game's native suggestions*.
 * This scans the known curated source, not every airport pair worldwide.
 * No prospect here may be fed directly into the reroute execution engine.
 */
export function discoverCatalogRoutesForAircraft(
  a:AircraftSnapshot,origin:string|null,catalog:RouteCatalog,airports:AirportCatalog|null,
  now=new Date(),maxAgeSeconds=300,limit=20
):CatalogAircraftDiscovery {
  if(!Number.isSafeInteger(limit)||limit<1||limit>100||!Number.isSafeInteger(maxAgeSeconds)||maxAgeSeconds<1)
    throw new Error('CATALOG_DISCOVERY_CONFIGURATION_INVALID');
  const unavailable=untrusted(a,origin);
  if(!code(origin)||!code(a.from)||!code(a.to)||!/^[1-9]\d*$/.test(a.aircraftId)||
    a.from===a.to||a.state!=='ready'||a.issue||!fresh(a.observedAt,now,maxAgeSeconds)||
    !a.capacity||!goodSeats(a.capacity)||a.capacity.Y+a.capacity.J+a.capacity.F<=0||
    !a.operational||!Number.isFinite(a.operational.rangeKm)||a.operational.rangeKm<=0||
    !Number.isSafeInteger(a.operational.minRunwayFt)||a.operational.minRunwayFt<=0||
    catalog.schemaVersion!==1||!Array.isArray(catalog.routes))return unavailable;
  const result:CatalogAircraftDiscovery={...unavailable,status:'no_verified_reference_candidates',
    reason:'NO_DIRECT_CANDIDATE_WITH_UNAMBIGUOUS_RUNWAY_AND_STATIC_DEMAND'};
  const candidates:CatalogDiscoveryCandidate[]=[];
  const relevant=catalog.routes.filter(r=>r.from===origin||r.to===origin);
  result.examinedRows=relevant.length;
  // Any conflicting record for the same undirected airport pair quarantines the whole pair.
  const grouped=new Map<string,ReferenceRoute[]>();
  for(const route of relevant){
    const other:string=route.from===origin?route.to:route.from;
    if(!code(other)||other===origin){result.excluded.invalidReference++;continue;}
    const key=pair(origin,other);grouped.set(key,[...(grouped.get(key)||[]),route]);
  }
  for(const [key,records] of grouped){
    const first=records[0];
    const anyConflict=records.some(r=>r.conflict===true||
      r.distanceKm!==first.distanceKm||
      r.referenceDemand?.Y!==first.referenceDemand?.Y||
      r.referenceDemand?.J!==first.referenceDemand?.J||
      r.referenceDemand?.F!==first.referenceDemand?.F);
    if(anyConflict){result.excluded.conflictedOrDuplicate+=records.length;continue;}
    // Exact duplicate records are processed once only, transparently counted.
    if(records.length>1)result.excluded.conflictedOrDuplicate+=records.length-1;
    if(!validRoute(first)){result.excluded.invalidReference++;continue;}
    const to=first.from===origin?first.to:first.from;
    if(first.distanceKm>a.operational.rangeKm){result.excluded.outOfRange++;continue;}
    const fromAirport=safeAirport(airports,origin),toAirport=safeAirport(airports,to);
    if(!fromAirport||!toAirport){result.excluded.runwayUnknown++;continue;}
    if(Math.min(fromAirport.runwayFt!,toAirport.runwayFt!)<a.operational.minRunwayFt){
      result.excluded.runwayTooShort++;continue;
    }
    const theoretical=communityRoutePriceScenarios(first.distanceKm,a.capacity,first.referenceDemand);
    if(!theoretical){result.excluded.noDemandOrFareEvidence++;continue;}
    const minGross=Math.min(
      theoretical.scenarios.easy.grossRevenueCeilingPerDeparture,
      theoretical.scenarios.realism.grossRevenueCeilingPerDeparture
    );
    const coverage=100*(['Y','J','F'] as const).reduce((sum,k)=>sum+
      Math.min(a.capacity![k],first.referenceDemand[k]),0)/(a.capacity.Y+a.capacity.J+a.capacity.F);
    if(!Number.isFinite(minGross)||!Number.isFinite(coverage)||coverage<=0){
      result.excluded.noDemandOrFareEvidence++;continue;
    }
    candidates.push({
      from:origin,to,distanceKm:first.distanceKm,sourceRow:first.sourceRow,referenceDemand:{...first.referenceDemand},
      minTheoreticalGrossAcrossModes:minGross,referenceSeatCoveragePercent:coverage,
      theoreticalFares:theoretical,
      sameAirportPairAsCurrentRoute:pair(a.from,a.to)===key,
      runwaySource:'airport-catalog-reference',demandSource:'curated-static-route-catalog',
      remainingDemand:null,netProfit:null,comparisonReady:false,mutationAuthorized:false
    });
  }
  candidates.sort((x,y)=>y.minTheoreticalGrossAcrossModes-x.minTheoreticalGrossAcrossModes||
    y.referenceSeatCoveragePercent-x.referenceSeatCoveragePercent||
    x.distanceKm-y.distanceKm||x.to.localeCompare(y.to));
  result.eligibleRowsBeforeLimit=candidates.length;
  result.ranked=candidates.slice(0,limit);
  if(result.ranked.length){
    result.status='ranked_reference';
    result.reason='CURATED_DIRECT_ROUTES_RANKED_BY_THEORETICAL_GROSS_NOT_NET_PROFIT';
  }
  return result;
}

export function discoverCatalogForFleet(
  collection:CollectionResult,
  origins:ReadonlyMap<string,string|null>,
  catalog:RouteCatalog,airports:AirportCatalog|null,
  configuredBases:readonly string[],now=new Date(),maxAgeSeconds=300,limit=20
):CatalogDiscoveryReport{
  const warnings:string[]=[];
  const coverageCodes=[...new Set([...configuredBases.filter(code),...Array.from(origins.values()).filter(code)])].sort();
  const coverage=coverageCodes.map(origin=>{
    const listed=catalog.routes.filter(r=>r.from===origin||r.to===origin);
    const distinct=new Set(listed.filter(r=>r.from!==r.to).map(r=>r.from===origin?r.to:r.from).filter(code));
    return {origin,listedRows:listed.length,distinctDestinations:distinct.size,
      unlistedDestinationsUnknown:true as const,source:'curated-route-catalog-not-global' as const};
  });
  if(coverage.some(c=>c.listedRows===0))warnings.push('CATALOG_BASE_NOT_COVERED');
  if(coverage.some(c=>c.listedRows>0&&c.listedRows<50))warnings.push('CATALOG_BASE_COVERAGE_SPARSE');
  if(!collection.complete)warnings.push('INCOMPLETE_FLEET_NO_CANDIDATES');
  const counts=new Map<string,number>();
  for(const a of collection.aircraft)counts.set(a.aircraftId,(counts.get(a.aircraftId)||0)+1);
  const aircraft=collection.aircraft.map(a=>collection.complete&&counts.get(a.aircraftId)===1?
    discoverCatalogRoutesForAircraft(a,origins.get(a.aircraftId)||null,catalog,airports,now,maxAgeSeconds,limit):
    untrusted(a,origins.get(a.aircraftId)||null));
  return {
    source:catalog.source,sourceSha256:catalog.sha256,referenceRows:catalog.routes.length,coverage,
    aircraft,rankedAcrossBases:false,catalogGlobalCoverageProven:false,authoritativeDemand:false,
    liveRouteValidationRequired:true,comparisonReady:false,mutationAuthorized:false,warnings
  };
}
