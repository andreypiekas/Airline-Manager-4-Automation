import { test, expect } from '@playwright/test';
import { aircraftReferenceByModel, AircraftCatalog, airportDistanceEvidence, airportRunwayEvidence, AirportCatalog, calendarReference, FuelCalendar, shortlistRoutes, RouteCatalog } from '../../optimization/reference-data';
import { AircraftSnapshot } from '../../demand/types';
const a:AircraftSnapshot={aircraftId:'1',routeId:'2',registration:'TEST',routeLabel:'GRU-BSB',from:'GRU',to:'BSB',state:'ready',capacity:{Y:100,J:0,F:0},remaining:{Y:0,J:0,F:0},dailyTotal:{Y:1,J:1,F:1},observedAt:new Date().toISOString(),operational:{rangeKm:5000,minRunwayFt:5000,flightHours:1,cycles:1,homeBase:null,flightId:null}};
const catalog:RouteCatalog={schemaVersion:1,source:'fixture',sha256:'test',routes:[{from:'GRU',to:'BSB',distanceKm:1000,referenceDemand:{Y:1000,J:0,F:0},sourceRow:2},{from:'GRU',to:'DTW',distanceKm:9000,referenceDemand:{Y:1000,J:0,F:0},sourceRow:3}]};
test('reference route shortlist filters direct range and never supplies remaining demand or profit',()=>{
 const r=shortlistRoutes(a,'GRU',catalog);expect(r).toHaveLength(1);expect(r[0]).toMatchObject({to:'BSB',remainingDemand:null,estimatedProfit:null,mutationAuthorized:false});expect(a.remaining!.Y).toBe(0);
});
test('airport coordinates cross-check a live quote without creating demand',()=>{
 const airports:AirportCatalog={schemaVersion:2,source:'fixture-airports',license:'MIT',generatedAt:'2026-10-02',airports:[
  {iata:'AAA',runwayFt:10000,lat:0,lng:0,sourceIds:[1]},
  {iata:'BBB',runwayFt:9000,lat:0,lng:1,sourceIds:[99]}
 ]};
 const r=airportDistanceEvidence('AAA','BBB',airports,111,'99');
 expect(r).toMatchObject({
  status:'cross_checked',distanceKm:111,deltaKm:0,destinationAirportIdMatches:true,
  comparisonReady:false,mutationAuthorized:false
 });
 const wrong=airportDistanceEvidence('AAA','BBB',airports,111,'100');
 expect(wrong.status).toBe('reference_only');
});
test('airport runway reference resolves both directions without authorizing comparison',()=>{
 const airports:AirportCatalog={schemaVersion:1,source:'fixture-airports',license:'MIT',generatedAt:'2026-10-02',airports:[
  {iata:'GRU',runwayFt:9843,sourceIds:[1]},{iata:'BSB',runwayFt:10827,sourceIds:[2]}
 ]};
 expect(airportRunwayEvidence('GRU','BSB',6000,airports)).toMatchObject({
  originRunwayFt:9843,destinationRunwayFt:10827,adequate:true,status:'reference_verified',
  comparisonReady:false,mutationAuthorized:false
 });
 expect(airportRunwayEvidence('BSB','GRU',10000,airports)).toMatchObject({adequate:false,status:'insufficient_reference'});
});
test('conflicting or missing runway reference fails closed',()=>{
 const airports:AirportCatalog={schemaVersion:1,source:'fixture-airports',license:'MIT',generatedAt:'2026-10-02',airports:[
  {iata:'GRU',runwayFt:null,sourceIds:[1,2],conflict:true,runwayCandidatesFt:[9000,10000]}
 ]};
 expect(airportRunwayEvidence('GRU','BSB',6000,airports)).toMatchObject({
  status:'unavailable',adequate:null,originObserved:false,destinationObserved:false
 });
});
test('community aircraft reference resolves only a unique primary variant',()=>{
 const aircrafts:AircraftCatalog={schemaVersion:1,source:'fixture-aircrafts',upstreamCommit:'abc',license:'MIT',generatedAt:'2026-10-02',models:[
  {modelId:383,variants:[
   {modelId:383,shortname:'vip',manufacturer:'Bombardier',modelName:'Challenger 605-VIP',type:2,priority:0,engineId:0,engineName:'unspecified',speedKph:900,fuelLbsPerKm:4,co2KgPerPaxKm:.05,acquisitionCost:860590,capacityUnits:12,minRunwayFt:3780,aCheckPrice:12705,rangeKm:10701,checkIntervalHours:2000},
   {modelId:383,shortname:'vip',manufacturer:'Bombardier',modelName:'Challenger 605-VIP',type:2,priority:1,engineId:166,engineName:'GE',speedKph:846,fuelLbsPerKm:3.68,co2KgPerPaxKm:.05,acquisitionCost:860590,capacityUnits:12,minRunwayFt:3780,aCheckPrice:12705,rangeKm:10701,checkIntervalHours:2000}
  ]}
 ]};
 expect(aircraftReferenceByModel(383,aircrafts)).toMatchObject({status:'unique',reference:{modelId:383,priority:0,aCheckPrice:12705,acquisitionCost:860590}});
 expect(aircraftReferenceByModel(999,aircrafts).status).toBe('unavailable');
 const bad={...aircrafts,models:[{modelId:383,variants:[...aircrafts.models[0].variants.map(v=>({...v,priority:0}))]}]};
 expect(aircraftReferenceByModel(383,bad as AircraftCatalog).status).toBe('ambiguous');
});
test('reverse source is disclosed and not silently treated as a live directional quote',()=>{
 const r=shortlistRoutes(a,'BSB',catalog);expect(r[0]).toMatchObject({from:'BSB',to:'GRU',sourceDirection:'GRU-BSB',remainingDemand:null});
});
test('conflicting, incomplete and out-of-range records cannot produce an actionable candidate',()=>{
 expect(shortlistRoutes(a,null,catalog)).toEqual([]);expect(shortlistRoutes({...a,operational:null},'GRU',catalog)).toEqual([]);
 expect(shortlistRoutes(a,'GRU',{...catalog,routes:catalog.routes.map(r=>({...r,conflict:true}))})).toEqual([]);
});
const cal:FuelCalendar={monthLength:30,utcOffsetMinutes:-180,source:'fixture',status:'ocr-unverified',days:[{day:1,page:2,verified:false,fuel:[[0,380],[90,800],[810,300]],co2:[[0,147]],fuelIssues:false,co2Issues:false}]};
test('fuel calendar uses fixed GMT-3 and only listed times, never forward-fills prices',()=>{
 const exact=calendarReference(new Date('2026-09-01T03:00:00Z'),cal,'fuel');expect(exact).toMatchObject({status:'ocr-unverified',listedPrice:380,purchaseAuthorized:false});
 const gap=calendarReference(new Date('2026-09-01T04:00:00Z'),cal,'fuel');expect(gap).toMatchObject({listedPrice:null,purchaseAuthorized:false});
});
test('calendar selects actual month length and refuses February or wrong dataset',()=>{
 expect(calendarReference(new Date('2026-10-01T12:00:00Z'),cal,'fuel').status).toBe('unsupported-month');
 expect(calendarReference(new Date('2028-02-01T12:00:00Z'),cal,'fuel').status).toBe('unsupported-month');
});
test('invalid or ambiguous OCR slots cannot be used',()=>{
 const bad={...cal,days:[{...cal.days[0],fuel:[[0,380],[0,400]]}]};expect(calendarReference(new Date('2026-09-01T03:00:00Z'),bad,'fuel').status).toBe('unavailable');
});

import { writeReferenceReport } from '../../optimization/reference-report';
import { optimizationConfig } from '../../optimization/report';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
test('packaged references generate a simulation artifact and incomplete collection has no candidates',async()=>{
 const directory=await mkdtemp(join(tmpdir(),'am4-reference-'));
 try {
  const collection={aircraft:[a],complete:true,expectedRoutes:1,warnings:[]};
  const config=optimizationConfig({AIRLINE_BASES_JSON:'["GRU"]'});
  const report=await writeReferenceReport(collection,config,directory,new Date('2026-09-01T03:00:00Z'));
  expect(report.warnings).toEqual([]);
  expect(report.routes[0]).toMatchObject({aircraftId:'1',candidates:expect.any(Array)});
   expect(report.routes[0]).toMatchObject({candidates:expect.arrayContaining([expect.objectContaining({
     communityPriceScenarios:expect.objectContaining({gameModeVerified:false,comparisonReady:false,mutationAuthorized:false,
       scenarios:expect.objectContaining({easy:expect.any(Object),realism:expect.any(Object)})})
   })])});
  const disk=JSON.parse(await readFile(join(directory,'reference-report.json'),'utf8'));
  expect(disk.routes[0].candidates.length).toBeGreaterThan(0);
  expect(disk).toMatchObject({dryRun:true,mutationAuthorized:false,referenceOnly:true,fuel:{status:'ocr-unverified',purchaseAuthorized:false}});
   expect(disk.catalogDiscovery).toMatchObject({
     catalogGlobalCoverageProven:false,authoritativeDemand:false,
     liveRouteValidationRequired:true,comparisonReady:false,mutationAuthorized:false,
     coverage:expect.arrayContaining([expect.objectContaining({origin:'GRU',unlistedDestinationsUnknown:true})])
   });
   expect(disk.catalogDiscovery.aircraft[0]).toMatchObject({
     status:'unavailable',ranked:[],mutationAuthorized:false
   });
  const incomplete=await writeReferenceReport({...collection,complete:false},config,directory);
  expect(incomplete.routes[0]).toMatchObject({candidates:[]});
 } finally {await rm(directory,{recursive:true,force:true});}
});
