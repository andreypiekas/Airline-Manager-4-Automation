import { expect, type Page } from '@playwright/test';
import type { AircraftSnapshot } from '../demand/types';
import type { AirportCatalog } from './reference-data';
import type { CatalogAircraftDiscovery } from './reference-discovery';
import { readOpenCandidateQuoteAfterVerifiedAjax, type CandidateQuote } from './quote-reader';
import { screenCandidateEconomics } from './economic-screen';
import { inspectRouteQuoteResponse } from './route-response-diagnostics';
import { assertNoInteractiveChallenge } from '../utils/challenge-guard';

export interface LiveCatalogTarget {
  from:string;to:string;airportId:string;
  sourceRow:number;
  /** This was selected using static economic and runway references, not live demand. */
  source:'curated-catalog-unambiguous-airport-id';
}

export interface LiveCatalogQuoteScan {
  aircraftId:string;
  attempted:number;observed:number;
  quotes:CandidateQuote[];
  screenedOut:Array<{airportId:string;to:string;coverageCeilingPercent:number|null;reason:string}>;
  warnings:string[];
  stoppedEarly:boolean;
  /** Sanitized phase of the failed read-only verification; never request, DOM or account content. */
  failureStage:null|'challenge'|'planner'|'response'|'quote_identity'|'screening'|'close';
  mutationAuthorized:false;
}

const exact=(s:string)=>/^[A-Z]{3}$/.test(s);
const noConflicted=(a:AirportCatalog|null,to:string)=>{
  if(!a||![1,2].includes(a.schemaVersion)||!Array.isArray(a.airports))return null;
  const matches=a.airports.filter(x=>x.iata===to&&!x.conflict);
  if(matches.length!==1||!Array.isArray(matches[0].sourceIds)||matches[0].sourceIds.length!==1)return null;
  const airportId=matches[0].sourceIds[0];
  return Number.isSafeInteger(airportId)&&airportId>0?String(airportId):null;
};

/** Select only unambiguous destination identifiers from independently sourced airport rows.
 * The source is incomplete; these are leads, NOT authorization to reroute.
 */
/**
 * Optional peer evidence only CHANGES INSPECTION ORDER. Remaining demand and
 * financial comparison are still recalculated independently after a fresh
 * native quote: this ranking never grants permission to create a route.
 */
export function selectLiveCatalogQuoteTargets(
  discovery:CatalogAircraftDiscovery,airports:AirportCatalog|null,
  alreadyInspected:readonly {to:string}[],maxQueries:number,
  fleet:readonly AircraftSnapshot[]=[],now=new Date(),maxAgeSeconds=300
):LiveCatalogTarget[]{
  if(!Number.isSafeInteger(maxQueries)||maxQueries<0||maxQueries>5)throw new Error('CATALOG_LIVE_QUERY_CONFIG_INVALID');
  if(maxQueries===0||discovery.status!=='ranked_reference'||!exact(discovery.origin||'')||
    !Array.isArray(discovery.ranked))return [];
  if(!Number.isFinite(now.getTime())||!Number.isSafeInteger(maxAgeSeconds)||maxAgeSeconds<=0)
    throw new Error('CATALOG_LIVE_QUERY_CONFIG_INVALID');
  const origin=discovery.origin!;
  const freshPeer=(a:AircraftSnapshot)=>!a.issue&&
    (a.state==='ready'||a.state==='inflight')&&a.operational!==null&&!!a.capacity&&
    !!a.remaining&&!!a.dailyTotal&&
    ['Y','J','F'].every(k=>{
      const cabin=k as 'Y'|'J'|'F';
      return Number.isSafeInteger(a.remaining![cabin])&&a.remaining![cabin]>=0&&
        Number.isSafeInteger(a.dailyTotal![cabin])&&a.dailyTotal![cabin]>=a.remaining![cabin];
    })&&
    Number.isFinite(Date.parse(a.observedAt))&&
    now.getTime()>=Date.parse(a.observedAt)&&
    now.getTime()-Date.parse(a.observedAt)<=maxAgeSeconds*1000;
  const peers=fleet.filter(freshPeer);
  const coverage=(dest:string)=>{
    const outbound=peers.some(a=>a.from===origin&&a.to===dest);
    const inbound=peers.some(a=>a.from===dest&&a.to===origin);
    return Number(outbound)+Number(inbound);
  };
  const ranks=discovery.ranked.map((r,index)=>({r,index,peerCoverage:coverage(r.to)}))
    .sort((a,b)=>b.peerCoverage-a.peerCoverage||a.index-b.index);
  const skip=new Set(alreadyInspected.map(x=>x.to));
  const result:LiveCatalogTarget[]=[];
  for(const {r} of ranks){
    if(result.length>=maxQueries)break;
    if(r.from!==discovery.origin||!exact(r.to)||skip.has(r.to)||r.sameAirportPairAsCurrentRoute)continue;
    const airportId=noConflicted(airports,r.to);
    if(!airportId)continue;
    skip.add(r.to);
    result.push({from:r.from,to:r.to,airportId,sourceRow:r.sourceRow,
      source:'curated-catalog-unambiguous-airport-id'});
  }
  return result;
}

const closeVerifiedQuote=async(page:Page,timeout:number)=>{
  const panel=page.locator('#newRouteInfo');
  const back=panel.getByRole('button',{name:/Back$/});
  if(await panel.count()!==1||!await panel.isVisible()||await back.count()!==1||
    !await back.isVisible()||!await back.isEnabled())throw new Error('CATALOG_QUOTE_BACK_CONTROL_UNVERIFIED');
  const onclick=await back.getAttribute('onclick')||'';
  if(!/^\$\('#newRouteInfo'\)\.hide\('fast'\);playSound\('neutral_click'\);(?:\/\*(?:(?!\*\/)[\s\S])*\*\/)?$/.test(onclick))
    throw new Error('CATALOG_QUOTE_BACK_CONTROL_UNVERIFIED');
  await back.click({timeout});
  await panel.waitFor({state:'hidden',timeout});
};

/**
 * Read-only native Ajax GET: neither mode=do nor Create route.
 * Stops on the first response/context/UI identity problem. Stale or ambiguous
 * observations never become candidate quotes.
 */
export async function collectLiveCatalogQuotes(
  page:Page,aircraft:AircraftSnapshot,origin:string,
  targets:readonly LiveCatalogTarget[],timeout=10000,minCoveragePercent=80
):Promise<LiveCatalogQuoteScan>{
  if(!Number.isSafeInteger(timeout)||timeout<1||timeout>30000||
    !Number.isFinite(minCoveragePercent)||minCoveragePercent<=0||minCoveragePercent>100||
    targets.length>5)throw new Error('CATALOG_LIVE_QUERY_CONFIG_INVALID');
  const output:LiveCatalogQuoteScan={
    aircraftId:aircraft.aircraftId,attempted:0,observed:0,quotes:[],screenedOut:[],
    warnings:[],stoppedEarly:false,failureStage:null,mutationAuthorized:false
  };
  const age=Date.now()-Date.parse(aircraft.observedAt);
  if(!Number.isFinite(age)||age<0||age>300000||aircraft.issue||aircraft.state!=='ready'||
    aircraft.from!==origin||!exact(origin)||!/^[1-9]\d*$/.test(aircraft.aircraftId)||
    !aircraft.registration){
    output.warnings.push('CATALOG_LIVE_AIRCRAFT_CONTEXT_UNVERIFIED');
    return output;
  }
  const ids=new Set<string>();
  for(const target of targets){
    if(!exact(target.from)||target.from!==origin||!exact(target.to)||target.to===origin||
      !/^[1-9]\d*$/.test(target.airportId)||ids.has(target.airportId)){
      output.stoppedEarly=true;
      output.warnings.push('CATALOG_LIVE_TARGET_AMBIGUOUS');
      break;
    }
    ids.add(target.airportId);
    output.attempted++;
    let stage:NonNullable<LiveCatalogQuoteScan['failureStage']>='challenge';
    try{
      await assertNoInteractiveChallenge(page,'route:catalog-quote');
      stage='planner';
      const trigger=page.locator('#flightInfoContainer #introSuggest');
      if(await trigger.count()!==1||!await trigger.isVisible()||
        !await trigger.isEnabled())throw new Error('CATALOG_PLANNER_CONTROL_UNVERIFIED');
      const onclick=(await trigger.getAttribute('onclick')||'').replace(/\s/g,'');
      const expected=`playSound('neutral_click');Ajax('add_airports.php?mode=suggest&id=${aircraft.aircraftId}','runme',this,false,true);`;
      if(!onclick.startsWith(expected.replace(/\s/g,'')))
        throw new Error('CATALOG_PLANNER_CONTEXT_UNVERIFIED');
      const panel=page.locator('#newRouteInfo');
      if(await panel.count()!==1||await panel.isVisible())throw new Error('CATALOG_PREVIOUS_PANEL_NOT_CLOSED');
      stage='response';
      const requestUrl=`new_route_info.php?id=${aircraft.aircraftId}&airportId=${target.airportId}&ferry=0`;
      const responsePromise=page.waitForResponse(r=>{
        try{
          const u=new URL(r.url());
          return r.request().method()==='GET'&&u.pathname.endsWith('/new_route_info.php')&&
            u.searchParams.get('id')===aircraft.aircraftId&&u.searchParams.get('airportId')===target.airportId&&
            u.searchParams.get('ferry')==='0'&&!u.searchParams.has('mode');
        }catch{return false;}
      },{timeout});
      await page.evaluate(({url})=>{
        const trigger=document.querySelector('#flightInfoContainer #introSuggest');
        const ajax=(window as any).Ajax;
        if(!trigger||typeof ajax!=='function')throw new Error('CATALOG_NATIVE_AJAX_UNAVAILABLE');
        ajax(url,'newRouteInfo',trigger,false,true);
      },{url:requestUrl});
      const response=await responsePromise;
      if(!response.ok())throw new Error('CATALOG_READONLY_QUOTE_RESPONSE_FAILED');
      await panel.waitFor({state:'visible',timeout});
      stage='quote_identity';
      const read=await readOpenCandidateQuoteAfterVerifiedAjax(page,{
        aircraftId:aircraft.aircraftId,registration:aircraft.registration,
        airportId:target.airportId,from:origin,to:target.to
      });
      if(read.status!=='observed')throw new Error('CATALOG_READONLY_QUOTE_IDENTITY_UNVERIFIED');
      stage='screening';
      const screening=screenCandidateEconomics(read.quote,aircraft.capacity,minCoveragePercent,new Date(),300);
      try{read.quote.routeResponseDiagnostics=inspectRouteQuoteResponse(await response.text());}
      catch{read.quote.routeResponseDiagnostics=inspectRouteQuoteResponse('');}
      if(screening.demandStatus==='cannot_meet_threshold'){
        output.screenedOut.push({airportId:target.airportId,to:target.to,
          coverageCeilingPercent:screening.coverageCeilingPercent,reason:screening.reason});
      }else output.quotes.push(read.quote);
      output.observed++;
      stage='close';
      await closeVerifiedQuote(page,timeout);
    }catch{
      output.stoppedEarly=true;
      output.failureStage=stage;
      output.warnings.push('CATALOG_LIVE_QUOTE_OR_UI_UNVERIFIED');
      break;
    }
  }
  if(!output.observed&&output.attempted>0)output.warnings.push('CATALOG_LIVE_NO_CONFIRMED_QUOTES');
  return output;
}
