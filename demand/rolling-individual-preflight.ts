import type { Page } from '@playwright/test';
import { inspectFirstPageReadOnly } from './rolling-first-page';
import { DemandReader } from './reader';
import { verifiedDepartureHandler } from './departure-port';
import { assertNoInteractiveChallenge } from '../utils/challenge-guard';
import type { AircraftSnapshot } from './types';

/**
 * Independent target proof. It never describes the 20-card window as a
 * complete fleet and it is intentionally incapable of triggering a departure.
 */
export interface IndividualPreflight {
  schemaVersion:1;
  mode:'read-only-individual';
  mutationAuthorized:false;
  window:'STABLE'|'SHORT_PAGE'|'UNVERIFIED'|'TIME_BUDGET';
  inspected:number;
  verified:number;
  readyCandidates:number;
  verifiedAircraft:AircraftSnapshot[];
  holds: Array<{code:
    'TARGET_MOVED_OR_CHANGED'|'TARGET_NOT_READY'|'TARGET_DETAILS_UNVERIFIED'|
    'TARGET_HANDLER_UNVERIFIED'|'TIME_BUDGET'|'WINDOW_UNVERIFIED'}>;
}

export async function inspectIndividualFirstPage(
  page:Page,
  options:{timeout?:number;maxCandidates?:number;deadlineEpochMs?:number}={}
):Promise<IndividualPreflight>{
  const timeout=options.timeout??4000,limit=options.maxCandidates??2,deadline=options.deadlineEpochMs;
  if(!Number.isSafeInteger(timeout)||timeout<100||timeout>30000||
    !Number.isSafeInteger(limit)||limit<1||limit>20||
    (deadline!==undefined&&(!Number.isSafeInteger(deadline)||deadline<1)))
    throw Error('INDIVIDUAL_PREFLIGHT_SETTINGS_INVALID');
  const report:IndividualPreflight={
    schemaVersion:1,mode:'read-only-individual',mutationAuthorized:false,
    window:'UNVERIFIED',inspected:0,verified:0,readyCandidates:0,verifiedAircraft:[],holds:[]
  };
  const budget=()=>deadline===undefined||Date.now()+Math.max(5000,timeout*2)<deadline;
  if(!budget()){report.window='TIME_BUDGET';return report;}
  const first=await inspectFirstPageReadOnly(page,timeout);
  if(!['STABLE','SHORT_PAGE'].includes(first.status)){
    report.holds.push({code:'WINDOW_UNVERIFIED'});return report;
  }
  report.window=first.status as 'STABLE'|'SHORT_PAGE';
  const candidates=first.aircraft.filter(a=>a.state==='ready');
  report.readyCandidates=candidates.length;
  for(const candidate of candidates.slice(0,limit)){
    if(!budget()){report.holds.push({code:'TIME_BUDGET'});break;}
    report.inspected++;
    try{
      // No stale pagination cursor is used: reopen first page each time and
      // require identical native route/aircraft/registration before opening
      // the sole target's current details.
      const again=await inspectFirstPageReadOnly(page,timeout);
      if(!['STABLE','SHORT_PAGE'].includes(again.status)){
        report.holds.push({code:'WINDOW_UNVERIFIED'});continue;
      }
      if(again.aircraft.filter(a=>a.aircraftId===candidate.aircraftId&&
        a.routeId===candidate.routeId&&a.registration===candidate.registration&&
        a.state==='ready').length!==1){
        report.holds.push({code:'TARGET_MOVED_OR_CHANGED'});continue;
      }
      await assertNoInteractiveChallenge(page,'individual-preflight:before-details');
      const fresh=await new DemandReader(page,timeout).readReadyCandidateOnVisiblePage(candidate);
      await assertNoInteractiveChallenge(page,'individual-preflight:after-details');
      const depart=page.locator('#detailsAction #routeViewDepart');
      const handler=await depart.count()===1?await depart.getAttribute('onclick')||'':'';
      if(!await depart.isVisible()||!await depart.isEnabled()||
         !verifiedDepartureHandler(handler,fresh.routeId)){
        report.holds.push({code:'TARGET_HANDLER_UNVERIFIED'});continue;
      }
      // The full native aircraft identity, cabins, live demand and verified
      // depart control were all examined on this single read-only target.
      // Dispatch remains a separate future executor with fuel/campaign/
      // uncertainty journal/pool protection; this object is NOT a click gate.
      report.verifiedAircraft.push(fresh);
      report.verified++;
    }catch(error){
      if(error instanceof Error&&error.message==='INTERACTIVE_CHALLENGE_DETECTED_STOP')throw error;
      report.holds.push({code:
        error instanceof Error&&error.message==='ROLLING_TARGET_MOVED_OR_CHANGED'
          ?'TARGET_MOVED_OR_CHANGED':
        error instanceof Error&&error.message==='ROLLING_TARGET_NOT_READY'
          ?'TARGET_NOT_READY':'TARGET_DETAILS_UNVERIFIED'});
    }finally{
      const back=page.locator('#route-name .glyphicons-chevron-left');
      try{
        if(await back.isVisible())await back.click({timeout});
        else if(await page.locator('#detailsAction').isVisible())
          throw Error('ROLLING_NAVIGATION_UNVERIFIED');
      }catch{
        // We may not safely navigate after an unexpected native panel
        // change. Stop all subsequent candidates.
        report.holds.push({code:'WINDOW_UNVERIFIED'});break;
      }
    }
  }
  return report;
}
