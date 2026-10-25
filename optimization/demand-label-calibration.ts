import { expect, Page } from '@playwright/test';
import type { AircraftSnapshot, Cabins, CollectionResult } from '../demand/types';
import { CLASSES } from '../demand/types';
import { integerText } from '../demand/parsing';
import { DemandReader } from '../demand/reader';
import { findFleetRoute, openFleetList } from '../demand/navigation';
import type { AirportCatalog } from './reference-data';
import { CandidateQuote, readOpenCandidateQuoteAfterVerifiedAjax } from './quote-reader';

export interface DemandLabelCalibrationSample {
  aircraftId:string;registration:string;routeId:string;from:string;to:string;airportId:number;
  observedAt:string;quoteDemand:Cabins;remaining:Cabins;dailyTotal:Cabins;
  currentRouteQuote:CandidateQuote|null;
  matchesRemaining:boolean;matchesDailyTotal:boolean;
}
export interface DemandLabelCalibrationReport {
  status:'observed'|'unavailable';
  observedAt:string;
  samples:DemandLabelCalibrationSample[];
  classification:'remaining'|'daily_total'|'mixed_or_unknown';
  comparisonReady:false;
  mutationAuthorized:false;
  uiRestored:boolean;
  warnings:string[];
}

const validCabins=(v:Cabins|null):v is Cabins=>!!v&&CLASSES.every(k=>Number.isSafeInteger(v[k])&&v[k]>=0);
const sameCabins=(a:Cabins,b:Cabins)=>CLASSES.every(k=>a[k]===b[k]);
export const demandCalibrationAirportCatalogSupported=(airports:AirportCatalog|null):airports is AirportCatalog=>
  !!airports&&[1,2].includes(airports.schemaVersion)&&Array.isArray(airports.airports);

export function classifyDemandLabelSamples(samples:DemandLabelCalibrationSample[]):DemandLabelCalibrationReport['classification'] {
  if(!samples.length)return 'mixed_or_unknown';
  const allRemaining=samples.every(s=>s.matchesRemaining&&!s.matchesDailyTotal);
  const allDaily=samples.every(s=>s.matchesDailyTotal&&!s.matchesRemaining);
  return allRemaining?'remaining':allDaily?'daily_total':'mixed_or_unknown';
}

async function readOpenDemandQuote(page:Page,expected:{registration:string;from:string;to:string}) {
  const panel=page.locator('#newRouteInfo');
  await panel.waitFor({state:'visible',timeout:10000});
  return panel.evaluate((el,expected)=>{
    const visible=(e:Element)=>!!e.getClientRects().length;
    const header=el.querySelector('.blue-bg');
    if(!header||!visible(header))throw new Error();
    const registration=Array.from(header.childNodes).filter(n=>n.nodeType===Node.TEXT_NODE).map(n=>n.textContent).join('').trim();
    const codes=Array.from(el.querySelectorAll('.col-3.m-text > b')).filter(visible).map(e=>e.textContent?.trim()||'');
    const rows=Array.from(el.querySelectorAll('td')).filter(e=>e.textContent?.trim()==='Daily pax demand'&&visible(e));
    if(registration!==expected.registration||codes.length!==2||codes[0]!==expected.from||codes[1]!==expected.to||rows.length!==1)throw new Error();
    const tableRows=rows[0].closest('table')?.querySelectorAll('tr');
    if(!tableRows||tableRows.length!==3||tableRows[2].children.length!==3)throw new Error();
    const images=tableRows[1].querySelectorAll('img');
    if(images.length!==3||['economy','business','first'].some((name,i)=>!images[i].getAttribute('src')?.endsWith('/'+name+'_seat.png')))throw new Error();
    return Array.from(tableRows[2].children).map(e=>e.textContent?.trim()||'');
  },expected);
}

/**
 * Read-only calibration of AM4's "Daily pax demand" label against already
 * collected current-route remaining and daily-total values. It never clicks
 * Create route and never turns the label into remaining demand by assumption.
 */
export async function calibrateDemandLabelOnCurrentRoutes(
  page:Page,collection:CollectionResult,airports:AirportCatalog|null,timeout=10000,maxSamples=3,
  onlyAircraftIds?:ReadonlySet<string>
):Promise<DemandLabelCalibrationReport>{
  const report:DemandLabelCalibrationReport={
    status:'unavailable',observedAt:new Date().toISOString(),samples:[],classification:'mixed_or_unknown',
    comparisonReady:false,mutationAuthorized:false,uiRestored:true,warnings:[]
  };
  if(!Number.isSafeInteger(timeout)||timeout<1||timeout>30000||!Number.isSafeInteger(maxSamples)||maxSamples<1||maxSamples>10||
    !collection.complete||!demandCalibrationAirportCatalogSupported(airports)||
    (onlyAircraftIds!==undefined&&(!onlyAircraftIds.size||onlyAircraftIds.size>maxSamples||
       [...onlyAircraftIds].some(id=>!/^[1-9]\d*$/.test(id)))))return report;
  const eligible=collection.aircraft.filter(a=>(!onlyAircraftIds||onlyAircraftIds.has(a.aircraftId))&&
    a.state==='ready'&&!a.issue&&validCabins(a.remaining)&&validCabins(a.dailyTotal)&&
    /^[1-9]\d*$/.test(a.aircraftId)&&/^[1-9]\d*$/.test(a.routeId)&&/^[A-Z0-9]{3}$/.test(a.from)&&/^[A-Z0-9]{3}$/.test(a.to)&&a.from!==a.to);
  for(const expected of eligible.slice(0,maxSamples)){
    try{
      const refs=airports.airports.filter(a=>a.iata===expected.to&&!a.conflict&&Number.isSafeInteger(a.runwayFt)&&a.runwayFt!>0);
      const ids=[...new Set(refs.flatMap(a=>a.sourceIds).filter(id=>Number.isSafeInteger(id)&&id>0))];
      if(ids.length!==1)throw new Error('AIRPORT_ID_REFERENCE_AMBIGUOUS');
      const airportId=ids[0];
      await openFleetList(page,timeout);await findFleetRoute(page,expected,timeout);
      const fresh=await new DemandReader(page,timeout,true).readReadyAircraftDetails(expected);
      if(fresh.state!=='ready'||fresh.issue||fresh.aircraftId!==expected.aircraftId||fresh.routeId!==expected.routeId||
        fresh.registration!==expected.registration||fresh.from!==expected.from||fresh.to!==expected.to||
        !validCabins(fresh.remaining)||!validCabins(fresh.dailyTotal))throw new Error('CURRENT_ROUTE_CONTEXT_CHANGED');
      const reroute=page.locator('#detailsAction').getByRole('button',{name:/Reroute$/});
      const callback=await reroute.getAttribute('onclick')||'';
      const match=callback.match(/^showFlightInfo\(this,(\d+),(\d+),false,true\);closePop\(\);$/);
      if(await reroute.count()!==1||!await reroute.isVisible()||!await reroute.isEnabled()||!match||match[1]!==fresh.aircraftId)
        throw new Error('REROUTE_NAVIGATION_UNVERIFIED');
      await reroute.click({timeout});
      await page.locator('#flightInfoContainer #introSuggest').waitFor({state:'visible',timeout});
      const url=`new_route_info.php?id=${fresh.aircraftId}&airportId=${airportId}&ferry=0`;
      await page.evaluate(({url})=>{
        const trigger=document.querySelector('#introSuggest');
        const ajax=(window as any).Ajax;
        if(typeof ajax!=='function'||!trigger)throw new Error();
        ajax(url,'newRouteInfo',trigger,false,true);
      },{url});
      const raw=await readOpenDemandQuote(page,{registration:fresh.registration,from:fresh.from,to:fresh.to});
      const quoteDemand={Y:integerText(raw[0]),J:integerText(raw[1]),F:integerText(raw[2])};
      const full=await readOpenCandidateQuoteAfterVerifiedAjax(page,{
        aircraftId:fresh.aircraftId,registration:fresh.registration,airportId:String(airportId),from:fresh.from,to:fresh.to
      });
      const currentRouteQuote=full.status==='observed'&&sameCabins(full.quote.dailyDemand,quoteDemand)?full.quote:null;
      const sample:DemandLabelCalibrationSample={
        aircraftId:fresh.aircraftId,registration:fresh.registration,routeId:fresh.routeId,from:fresh.from,to:fresh.to,airportId,
        observedAt:new Date().toISOString(),quoteDemand,remaining:{...fresh.remaining},dailyTotal:{...fresh.dailyTotal},currentRouteQuote,
        matchesRemaining:sameCabins(quoteDemand,fresh.remaining),matchesDailyTotal:sameCabins(quoteDemand,fresh.dailyTotal)
      };
      report.samples.push(sample);
      const back=page.locator('#newRouteInfo').getByRole('button',{name:/Back$/});
      if(await back.count()===1&&await back.isVisible())await back.click({timeout});
    }catch(error){
      if(error instanceof Error&&error.message.includes('INTERACTIVE_CHALLENGE_DETECTED_STOP'))throw error;
      report.warnings.push('CURRENT_ROUTE_DEMAND_LABEL_SAMPLE_UNAVAILABLE:'+expected.aircraftId);
    }finally{
      try{await openFleetList(page,timeout);}catch{report.uiRestored=false;report.warnings.push('DEMAND_LABEL_LIST_RESTORE_FAILED');break;}
    }
  }
  if(report.samples.length){
    // If remaining equals daily total, that sample is deliberately inconclusive.
    report.classification=classifyDemandLabelSamples(report.samples);
    report.status='observed';report.observedAt=new Date().toISOString();
  }
  return report;
}
