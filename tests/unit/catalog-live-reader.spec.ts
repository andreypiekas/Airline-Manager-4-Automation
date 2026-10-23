import { expect,test } from '@playwright/test';
import { selectLiveCatalogQuoteTargets,collectLiveCatalogQuotes } from '../../optimization/catalog-live-reader';
import type { AirportCatalog } from '../../optimization/reference-data';
import type { CatalogAircraftDiscovery } from '../../optimization/reference-discovery';
import type { AircraftSnapshot } from '../../demand/types';

const airports:AirportCatalog={
  schemaVersion:2,source:'fixture',license:'MIT',generatedAt:'2026-10-23',
  airports:[
    {iata:'AAA',runwayFt:12000,sourceIds:[1]},
    {iata:'BBB',runwayFt:11000,sourceIds:[200]},
    {iata:'CCC',runwayFt:11000,sourceIds:[300]},
    {iata:'DDD',runwayFt:11000,sourceIds:[400,401]},
    {iata:'EEE',runwayFt:11000,sourceIds:[500],conflict:true}
  ]
};
const candidate=(to:string,same=false)=>({
  from:'AAA',to,distanceKm:1000,sourceRow:5,referenceDemand:{Y:200,J:50,F:0},
  minTheoreticalGrossAcrossModes:50000,referenceSeatCoveragePercent:99,
  theoreticalFares:{} as any,sameAirportPairAsCurrentRoute:same,
  runwaySource:'airport-catalog-reference' as const,demandSource:'curated-static-route-catalog' as const,
  remainingDemand:null,netProfit:null,comparisonReady:false as const,mutationAuthorized:false as const
});
const discovery={
  aircraftId:'101',registration:'TEST-101',origin:'AAA',status:'ranked_reference',examinedRows:20,
  eligibleRowsBeforeLimit:5,excluded:{conflictedOrDuplicate:0,invalidReference:0,outOfRange:0,
    runwayUnknown:0,runwayTooShort:0,noDemandOrFareEvidence:0},
  ranked:[candidate('BBB'),candidate('CCC'),candidate('DDD'),candidate('EEE'),candidate('AAA',true)],
  reason:'REFERENCE_ONLY',source:'curated-route-catalog-not-global',exhaustiveSearch:false,
  comparisonReady:false,mutationAuthorized:false
} as CatalogAircraftDiscovery;
const fresh=():AircraftSnapshot=>({
  aircraftId:'101',registration:'TEST-101',routeId:'1',routeLabel:'AAA-ZZZ',
  from:'AAA',to:'ZZZ',state:'ready',observedAt:new Date().toISOString(),
  capacity:{Y:100,J:10,F:5},remaining:null,dailyTotal:null
});

test('discovery selects only unique reference airport IDs and skips already queried destinations',()=>{
  const selected=selectLiveCatalogQuoteTargets(discovery,airports,[{to:'BBB'}],4);
  expect(selected).toEqual([{from:'AAA',to:'CCC',airportId:'300',sourceRow:5,
    source:'curated-catalog-unambiguous-airport-id'}]);
  expect(selectLiveCatalogQuoteTargets(discovery,airports,[],1).map(x=>x.to)).toEqual(['BBB']);
  expect(selectLiveCatalogQuoteTargets(discovery,airports,[],0)).toEqual([]);
  expect(()=>selectLiveCatalogQuoteTargets(discovery,airports,[],6))
    .toThrow('CATALOG_LIVE_QUERY_CONFIG_INVALID');
});

test('incomplete catalog discovery cannot produce requests',()=>{
  expect(selectLiveCatalogQuoteTargets({...discovery,status:'unavailable'},airports,[],5)).toEqual([]);
  expect(selectLiveCatalogQuoteTargets(discovery,null,[],5)).toEqual([]);
  expect(selectLiveCatalogQuoteTargets({...discovery,origin:null},airports,[],5)).toEqual([]);
});

test('read-only probe with invalid native quote never sends create-route mutation',async({page})=>{
  const urls:string[]=[];
  await page.route('https://am4.test/**',async route=>{
    urls.push(route.request().url());
    await route.fulfill({status:200,body:'not a valid quote'});
  });
  await page.setContent(`<div id="flightInfoContainer">
    <button id="introSuggest" onclick="playSound('neutral_click');Ajax('add_airports.php?mode=suggest&id=101','runme',this,false,true);"></button>
    </div><div id="newRouteInfo" style="display:none"></div>
    <script>window.Ajax=(u)=>fetch('https://am4.test/'+u);</script>`);
  const result=await collectLiveCatalogQuotes(page,fresh(),'AAA',
    selectLiveCatalogQuoteTargets(discovery,airports,[],1),1000);
  expect(result).toMatchObject({attempted:1,observed:0,stoppedEarly:true,mutationAuthorized:false,
    warnings:expect.arrayContaining(['CATALOG_LIVE_QUOTE_OR_UI_UNVERIFIED'])});
  expect(urls).toHaveLength(1);
  expect(urls[0]).toContain('new_route_info.php?id=101&airportId=200&ferry=0');
  expect(urls.every(x=>!x.includes('mode=do'))).toBe(true);
});

test('stale aircraft is rejected before any read-only requests',async({page})=>{
  const result=await collectLiveCatalogQuotes(page,
    {...fresh(),observedAt:new Date(Date.now()-310000).toISOString()},'AAA',
    selectLiveCatalogQuoteTargets(discovery,airports,[],2));
  expect(result).toMatchObject({attempted:0,observed:0,mutationAuthorized:false,
    warnings:['CATALOG_LIVE_AIRCRAFT_CONTEXT_UNVERIFIED']});
});
