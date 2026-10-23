import { expect, test } from '@playwright/test';
import type { AircraftSnapshot, CollectionResult } from '../../demand/types';
import type { AirportCatalog, RouteCatalog, ReferenceRoute } from '../../optimization/reference-data';
import { discoverCatalogRoutesForAircraft,discoverCatalogForFleet } from '../../optimization/reference-discovery';

const now=new Date('2026-10-23T12:00:00.000Z');
const a:AircraftSnapshot={
  aircraftId:'42',registration:'XP0042',routeId:'10',routeLabel:'GRU-BSB',from:'GRU',to:'BSB',
  state:'ready',capacity:{Y:100,J:20,F:0},remaining:null,dailyTotal:null,observedAt:now.toISOString(),
  operational:{rangeKm:5500,minRunwayFt:6000,flightHours:1,cycles:1,homeBase:null,flightId:null}
};
const route=(from:string,to:string,km:number,Y:number,J:number,F:number,sourceRow:number,conflict=false):ReferenceRoute=>
  ({from,to,distanceKm:km,referenceDemand:{Y,J,F},sourceRow,...(conflict?{conflict:true}:{})});
const catalog:RouteCatalog={schemaVersion:1,source:'static-fixture',sha256:'abc',routes:[
  route('GRU','AAA',1000,500,100,10,1),
  route('AAA','GRU',1000,500,100,10,2), // identical pair; counted only once
  route('GRU','BBB',1100,250,50,30,3),
  route('GRU','BSB',1200,350,100,40,4), // current same airport pair is NOT blocked
  route('GRU','CCC',700,150,50,20,5),
  route('GRU','DDD',5600,1000,1000,1000,6), // exceeds range
  route('GRU','EEE',900,1000,1000,1000,7), // unknown destination runway
  route('GRU','FFF',800,1000,1000,1000,8), // short runway
  route('GRU','GGG',950,100,0,0,9),
  route('GGG','GRU',950,200,0,0,10), // conflicting directions -> quarantine
  route('GRU','HHH',1100,0,0,0,11),
  route('DTW','AAA',1400,100,20,0,12)
]};
const airport=(iata:string,runwayFt:number|null,conflict=false)=>({
  iata,runwayFt,sourceIds:[100],...(conflict?{conflict:true}: {})
});
const airports:AirportCatalog={schemaVersion:2,source:'fixture-airport-reference',license:'MIT',generatedAt:'2026-10-23',airports:[
  airport('GRU',10000),airport('AAA',9000),airport('BBB',9000),airport('BSB',9000),
  airport('CCC',9000),airport('DDD',9000),airport('FFF',3000),
  airport('GGG',9000),airport('HHH',9000)
]};
const collection:CollectionResult={aircraft:[a],complete:true,expectedRoutes:1,warnings:[]};

test('searches all known origin rows without native suggestion list and quarantines conflicting pairs',()=>{
  const result=discoverCatalogRoutesForAircraft(a,'GRU',catalog,airports,now);
  expect(result.status).toBe('ranked_reference');
  expect(result.examinedRows).toBe(11);
  expect(result.excluded).toMatchObject({
    conflictedOrDuplicate:3,outOfRange:1,runwayUnknown:1,runwayTooShort:1,
    noDemandOrFareEvidence:1
  });
  expect(result.eligibleRowsBeforeLimit).toBe(4);
  expect(result.ranked.map(x=>x.to).sort()).toEqual(['AAA','BBB','BSB','CCC']);
  expect(result.ranked.find(x=>x.to==='BSB')?.sameAirportPairAsCurrentRoute).toBe(true);
  expect(result.ranked.every(x=>x.remainingDemand===null&&x.netProfit===null&&
    x.comparisonReady===false&&x.mutationAuthorized===false)).toBe(true);
  expect(result.exhaustiveSearch).toBe(false);
});

test('ranking uses static gross only, and remains per aircraft without claimed global optimum',()=>{
  const x=discoverCatalogRoutesForAircraft(a,'GRU',catalog,airports,now,300,2);
  expect(x.ranked).toHaveLength(2);
  expect(x.eligibleRowsBeforeLimit).toBe(4);
  expect(x.ranked[0].minTheoreticalGrossAcrossModes)
    .toBeGreaterThanOrEqual(x.ranked[1].minTheoreticalGrossAcrossModes);
  const f=x.ranked[0].theoreticalFares;
  expect(f.gameModeVerified).toBe(false);
  expect(f.scenarios.easy.fares.Y).toBeGreaterThan(f.scenarios.realism.fares.Y);
  expect(f.mutationAuthorized).toBe(false);
  expect(x.ranked[0].referenceSeatCoveragePercent).toBeLessThanOrEqual(100);
});

test('unknown, conflicted and too-short airport runways do not become route candidates',()=>{
  const badAirport={...airports,airports:airports.airports.map(r=>r.iata==='GRU'?{...r,conflict:true}:r)};
  expect(discoverCatalogRoutesForAircraft(a,'GRU',catalog,badAirport,now).ranked).toEqual([]);
  expect(discoverCatalogRoutesForAircraft(a,'GRU',catalog,null,now).ranked).toEqual([]);
});

test('complete and fresh aircraft identity is mandatory for comparison-safe reference candidates',()=>{
  for(const changed of [
    {...a,state:'inflight' as const},
    {...a,issue:'ambiguous aircraft'},
    {...a,observedAt:new Date(now.getTime()-301000).toISOString()},
    {...a,operational:null},
    {...a,capacity:null}
  ]){
    expect(discoverCatalogRoutesForAircraft(changed,'GRU',catalog,airports,now)).toMatchObject({
      status:'unavailable',ranked:[],mutationAuthorized:false
    });
  }
  expect(()=>discoverCatalogRoutesForAircraft(a,'GRU',catalog,airports,now,300,101))
    .toThrow('CATALOG_DISCOVERY_CONFIGURATION_INVALID');
});

test('explicit origin coverage acknowledges sparse and unknown hubs instead of claiming no routes',()=>{
  const r=discoverCatalogForFleet(collection,new Map([['42','GRU']]),catalog,airports,
    ['GRU','DTW','TXL'],now);
  expect(r.coverage).toMatchObject([
    {origin:'DTW',listedRows:1,unlistedDestinationsUnknown:true},
    {origin:'GRU',listedRows:11,unlistedDestinationsUnknown:true},
    {origin:'TXL',listedRows:0,unlistedDestinationsUnknown:true}
  ]);
  expect(r.warnings).toContain('CATALOG_BASE_NOT_COVERED');
  expect(r.warnings).toContain('CATALOG_BASE_COVERAGE_SPARSE');
  expect(r.catalogGlobalCoverageProven).toBe(false);
  expect(r.rankedAcrossBases).toBe(false);
  expect(r.authoritativeDemand).toBe(false);
  expect(r.liveRouteValidationRequired).toBe(true);
  expect(discoverCatalogForFleet({...collection,complete:false},new Map([['42','GRU']]),
    catalog,airports,['GRU'],now).aircraft[0].ranked).toEqual([]);
  expect(discoverCatalogForFleet({...collection,aircraft:[a,{...a}]},
    new Map([['42','GRU']]),catalog,airports,['GRU'],now).aircraft
    .every(x=>x.status==='unavailable')).toBe(true);
});
