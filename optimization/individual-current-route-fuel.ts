import type { Page } from '@playwright/test';
import type { AircraftSnapshot, CollectionResult } from '../demand/types';
import { inspectFirstPageReadOnly } from '../demand/rolling-first-page';
import { DemandReader } from '../demand/reader';
import { assertNoInteractiveChallenge } from '../utils/challenge-guard';
import type { AirportCatalog } from './reference-data';
import { readOpenCandidateQuoteAfterVerifiedAjax } from './quote-reader';

export interface IndividualCurrentRouteFuelQuote {
  aircraftId:string;routeId:string;from:string;to:string;fuelLbs:number;observedAt:string;
}

const sameTarget=(a:AircraftSnapshot,b:AircraftSnapshot)=>a.aircraftId===b.aircraftId&&
  a.routeId===b.routeId&&a.registration===b.registration&&
  a.from===b.from&&a.to===b.to&&a.state==='ready'&&b.state==='ready'&&
  !a.issue&&!b.issue;

/**
 * First-page identity is NOT a complete Fleet inventory. This independent
 * gate authorizes only a read-only quote for one already verified target;
 * it cannot authorize a departure, route mutation or global completion.
 */
export function selectVerifiedRollingFuelTarget(
  collection:CollectionResult|null,expected:AircraftSnapshot
):AircraftSnapshot|null {
  if(!collection||collection.complete!==false||
    collection.observationScope!=='native-individual-first-page'||
    collection.expectedRoutes===null||!Number.isSafeInteger(collection.expectedRoutes)||
    collection.expectedRoutes<collection.aircraft.length||
    collection.aircraft.length<1||collection.aircraft.length>20||
    !Number.isSafeInteger(collection.windowReadyCandidates)||
    collection.windowReadyCandidates!<collection.aircraft.length||
    !/^[1-9]\d*$/.test(expected.aircraftId)||!/^[1-9]\d*$/.test(expected.routeId)||
    !expected.registration.trim()||!/^[A-Z0-9]{3}$/.test(expected.from)||
    !/^[A-Z0-9]{3}$/.test(expected.to)||expected.from===expected.to)
    return null;
  const aircraftIds=new Set<string>(),routeIds=new Set<string>();
  for(const a of collection.aircraft){
    if(a.state!=='ready'||a.issue||!a.registration.trim()||
      !/^[1-9]\d*$/.test(a.aircraftId)||!/^[1-9]\d*$/.test(a.routeId)||
      aircraftIds.has(a.aircraftId)||routeIds.has(a.routeId)||
      !a.capacity||!a.remaining||!a.dailyTotal)return null;
    aircraftIds.add(a.aircraftId);routeIds.add(a.routeId);
  }
  const matches=collection.aircraft.filter(a=>sameTarget(a,expected));
  return matches.length===1?matches[0]:null;
}

/** Return from the native Reroute quote before reopening Fleet.
 * The live quote can overlay or hide the Fleet controls. A direct Fleet
 * open while #newRouteInfo remains visible caused #1317/#1318 to halt.
 * This performs navigation ONLY and never clicks Depart/Create route.
 */
export async function restoreRollingFuelFirstPage(page:Page,timeout:number):Promise<void>{
  await assertNoInteractiveChallenge(page,'departure:rolling-fuel:restore-start');
  const quote=page.locator('#newRouteInfo');
  if(await quote.count()>1)throw Error('ROLLING_FUEL_QUOTE_PANEL_AMBIGUOUS');
  if(await quote.count()===1&&await quote.isVisible()){
    const back=quote.getByRole('button',{name:/Back$/});
    if(await back.count()!==1||!await back.isVisible()||!await back.isEnabled())
      throw Error('ROLLING_FUEL_NATIVE_BACK_UNVERIFIED');
    // AM4's own Back control returns from the quote. Do not fabricate a
    // dismiss endpoint, call Create route, or retry an uncertain mutation.
    await back.click({timeout});
    if(await quote.isVisible())throw Error('ROLLING_FUEL_QUOTE_NOT_CLOSED');
  }
  // The existing first-page inspector handles already-open Fleet, native
  // routes.php in-place refresh, and a new Fleet menu open. Its two full
  // identity/cursor samples are evidence, never departure authorization.
  const observation=await inspectFirstPageReadOnly(page,timeout,{allowAlreadyOpen:true});
  if(!['STABLE','SHORT_PAGE'].includes(observation.status)||
     observation.mutationAuthorized!==false||
     !await page.locator('#routeAction').isVisible()||
     await quote.isVisible())
    throw Error('ROLLING_FUEL_FIRST_PAGE_NOT_RESTORED');
}

/**
 * Native, read-only JIT fuel quote for a single rolling first-page target.
 * Does not manufacture a complete Fleet snapshot or bypass the existing
 * complete-inventory requirement of demand-label calibration.
 * Every identity, direction, source airport ID and UI restoration is checked.
 * Any missing evidence remains a HOLD in the caller.
 */
export async function readVerifiedRollingCurrentRouteFuel(
  page:Page,expected:AircraftSnapshot,airports:AirportCatalog,
  expectedRouteTotal:number,timeout=10000
):Promise<IndividualCurrentRouteFuelQuote|null>{
  if(!Number.isSafeInteger(timeout)||timeout<1||timeout>30000||
    !Number.isSafeInteger(expectedRouteTotal)||expectedRouteTotal<1||
    ![1,2].includes(airports.schemaVersion)||!Array.isArray(airports.airports))
    return null;
  const refs=airports.airports.filter(a=>a.iata===expected.to&&!a.conflict&&
    Number.isSafeInteger(a.runwayFt)&&a.runwayFt!>0);
  const ids=[...new Set(refs.flatMap(a=>a.sourceIds).filter(id=>Number.isSafeInteger(id)&&id>0))];
  if(ids.length!==1)return null;
  await assertNoInteractiveChallenge(page,'departure:rolling-fuel:before');
  let challengeDetected=false;
  let rerouteNavigationAttempted=false;
  try{
    const first=await inspectFirstPageReadOnly(page,timeout);
    if(!['STABLE','SHORT_PAGE'].includes(first.status)||
      first.routeTotal!==expectedRouteTotal||
      first.aircraft.filter(a=>a.aircraftId===expected.aircraftId&&
        a.routeId===expected.routeId&&a.registration===expected.registration&&
        a.state==='ready').length!==1)return null;
    const fresh=await new DemandReader(page,timeout,true).readReadyCandidateOnVisiblePage(expected);
    if(!sameTarget(fresh,expected)||!fresh.capacity||!fresh.remaining||!fresh.dailyTotal)
      return null;
    await assertNoInteractiveChallenge(page,'departure:rolling-fuel:before-planner');
    const reroute=page.locator('#detailsAction').getByRole('button',{name:/Reroute$/});
    const callback=await reroute.getAttribute('onclick')||'';
    const match=callback.match(/^showFlightInfo\(this,(\d+),(\d+),false,true\);closePop\(\);$/);
    if(await reroute.count()!==1||!await reroute.isVisible()||
      !await reroute.isEnabled()||!match||match[1]!==fresh.aircraftId)
      return null;
    rerouteNavigationAttempted=true;
    await reroute.click({timeout});
    await page.locator('#flightInfoContainer #introSuggest').waitFor({state:'visible',timeout});
    const url='new_route_info.php?id='+fresh.aircraftId+'&airportId='+ids[0]+'&ferry=0';
    await page.evaluate(({url})=>{
      const trigger=document.querySelector('#introSuggest');
      const ajax=(window as any).Ajax;
      if(typeof ajax!=='function'||!trigger)throw new Error();
      ajax(url,'newRouteInfo',trigger,false,true);
    },{url});
    const observed=await readOpenCandidateQuoteAfterVerifiedAjax(page,{
      aircraftId:fresh.aircraftId,registration:fresh.registration,
      airportId:String(ids[0]),from:fresh.from,to:fresh.to
    });
    if(observed.status!=='observed')return null;
    const q=observed.quote;
    if(q.aircraftId!==fresh.aircraftId||q.registration!==fresh.registration||
      q.from!==fresh.from||q.to!==fresh.to||
      !Number.isSafeInteger(q.fuelLbs)||q.fuelLbs<=0||
      !Number.isFinite(Date.parse(q.observedAt)))return null;
    return {aircraftId:fresh.aircraftId,routeId:fresh.routeId,from:fresh.from,
      to:fresh.to,fuelLbs:q.fuelLbs,observedAt:q.observedAt};
  }catch(error){
    if(error instanceof Error&&error.message==='INTERACTIVE_CHALLENGE_DETECTED_STOP'){
      challengeDetected=true;
      throw error;
    }
    return null;
  }finally{
    // A detected CAPTCHA must never trigger another UI action, even for
    // restoration. The executor will halt rather than risk a click.
    if(!challengeDetected&&rerouteNavigationAttempted){
      try{
        await restoreRollingFuelFirstPage(page,timeout);
        await assertNoInteractiveChallenge(page,'departure:rolling-fuel:after');
      }catch(error){
        if(error instanceof Error&&error.message==='INTERACTIVE_CHALLENGE_DETECTED_STOP')
          throw error;
        // Only allowlisted stage codes: never persist DOM, URLs or callback text.
        const reason=error instanceof Error&&[
          'ROLLING_FUEL_QUOTE_PANEL_AMBIGUOUS','ROLLING_FUEL_NATIVE_BACK_UNVERIFIED',
          'ROLLING_FUEL_QUOTE_NOT_CLOSED','ROLLING_FUEL_FIRST_PAGE_NOT_RESTORED',
          'RESEARCH_LIST_CONTROL_UNVERIFIED','RESEARCH_QUOTE_NOT_CLOSED',
          'FLEET_REFRESH_NATIVE_RESPONSE_UNVERIFIED'
        ].includes(error.message)?error.message:'NAVIGATION_OR_UI_TIMEOUT';
        console.warn('[DepartureFuelQuoteRestore] '+JSON.stringify({status:'UNVERIFIED',reason,
          mutationAuthorized:false,globalFleetScans:0}));
        // Do not continue to a Depart click from an unverified UI context.
        throw new Error('DEPARTURE_FUEL_QUOTE_UI_RESTORE_FAILED');
      }
    }
  }
}
