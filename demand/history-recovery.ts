import { type Page } from '@playwright/test';
import { DemandReader } from './reader';
import { findFleetRoute, openFleetList } from './navigation';
import { type AircraftSnapshot, type Cabins, type CollectionResult, CLASSES } from './types';
import { assertNoInteractiveChallenge } from '../utils/challenge-guard';

export interface FlightHistoryRecoveryReport {
  schemaVersion:1;attempted:number;recovered:number;
  candidates:number;uiRestored:boolean;
  warnings:string[];readOnly:true;mutationAuthorized:false;
}

const sameCabins=(a:Cabins|null|undefined,b:Cabins|null|undefined)=>
  !!a&&!!b&&CLASSES.every(k=>a[k]===b[k]);

/** Recover only an independently reobserved history with the SAME aircraft,
 * current route, flight cycle, direction and demand snapshot.
 * Never join an old demand context to a different/new flight.
 */
export function validFreshHistoryRecovery(expected:AircraftSnapshot,fresh:AircraftSnapshot):boolean {
  const current=Date.parse(fresh.observedAt),old=Date.parse(expected.observedAt);
  return !expected.issue&&!fresh.issue&&expected.aircraftId===fresh.aircraftId&&
    expected.registration===fresh.registration&&expected.routeId===fresh.routeId&&
    expected.from===fresh.from&&expected.to===fresh.to&&expected.state===fresh.state&&
    (expected.state==='ready'||expected.state==='inflight')&&
    !!expected.operational&&!!fresh.operational&&
    Number.isSafeInteger(expected.operational.cycles)&&
    expected.operational.cycles===fresh.operational.cycles&&
    sameCabins(expected.capacity,fresh.capacity)&&
    sameCabins(expected.dailyTotal,fresh.dailyTotal)&&
    sameCabins(expected.remaining,fresh.remaining)&&
    (expected.state!=='inflight'||sameCabins(expected.onboard,fresh.onboard))&&
    expected.flightHistory?.status!=='observed'&&
    fresh.flightHistory?.status==='observed'&&
    Number.isFinite(current)&&Number.isFinite(old)&&current>=old&&
    Date.parse(fresh.flightHistory.observedAt)>=old&&
    Array.isArray(fresh.flightHistory.entries)&&
    fresh.flightHistory.entries.length>0;
}

export function selectMissingFlightHistory(collection:CollectionResult,max=2):AircraftSnapshot[]{
  if(!Number.isSafeInteger(max)||max<1||max>3)throw new Error('FLIGHT_HISTORY_RECOVERY_CONFIG_INVALID');
  if(!collection.complete||collection.expectedRoutes!==collection.aircraft.length||
    new Set(collection.aircraft.map(a=>a.aircraftId)).size!==collection.aircraft.length||
    new Set(collection.aircraft.map(a=>a.routeId)).size!==collection.aircraft.length)return [];
  const missing=collection.aircraft.filter(a=>
    (a.state==='ready'||a.state==='inflight')&&!a.issue&&
    a.flightHistory?.status!=='observed');
  // If many histories are missing, a transient UI failure is more likely
  // than one isolated lazy panel. Do not launch an unbounded repair scan.
  return missing.length>max?[]:missing;
}

/** One bounded read-only second inspection of at most two missing histories.
 * An unverified Fleet restoration is fatal so no later mutation is possible.
 */
export async function recoverMissingFlightHistories(
  page:Page,collection:CollectionResult,timeout=10000,retryDeadlineEpochMs?:number
):Promise<FlightHistoryRecoveryReport>{
  if(!Number.isSafeInteger(timeout)||timeout<1000||timeout>30000||
    (retryDeadlineEpochMs!==undefined&&(!Number.isSafeInteger(retryDeadlineEpochMs)||retryDeadlineEpochMs<=0)))
    throw new Error('FLIGHT_HISTORY_RECOVERY_CONFIG_INVALID');
  const candidates=selectMissingFlightHistory(collection);
  const result:FlightHistoryRecoveryReport={
    schemaVersion:1,attempted:0,recovered:0,candidates:candidates.length,
    uiRestored:true,warnings:[],readOnly:true,mutationAuthorized:false
  };
  // No retry when the operation could jeopardize the run's completion budget.
  if(!candidates.length)return result;
  if(retryDeadlineEpochMs!==undefined&&Date.now()+180000>=retryDeadlineEpochMs){
    result.warnings.push('FLIGHT_HISTORY_RECOVERY_BUDGET_INSUFFICIENT');
    return result;
  }
  try{
    for(const expected of candidates){
      if(retryDeadlineEpochMs!==undefined&&Date.now()+180000>=retryDeadlineEpochMs){
        result.warnings.push('FLIGHT_HISTORY_RECOVERY_BUDGET_EXHAUSTED');
        break;
      }
      result.attempted++;
      try{
        await assertNoInteractiveChallenge(page,'flight-history-recovery:before');
        await openFleetList(page,timeout);
        await findFleetRoute(page,expected,timeout);
        const fresh=await new DemandReader(page,timeout,true).readAircraftDetails(expected);
        if(!validFreshHistoryRecovery(expected,fresh)){
          result.warnings.push('FLIGHT_HISTORY_RECOVERY_CONTEXT_UNVERIFIED');
          continue;
        }
        expected.flightHistory=fresh.flightHistory;
        result.recovered++;
      }catch(error){
        if(error instanceof Error&&error.message.includes('INTERACTIVE_CHALLENGE_DETECTED_STOP'))throw error;
        result.warnings.push('FLIGHT_HISTORY_RECOVERY_INSPECTION_FAILED');
      }
    }
  }finally{
    try{
      await assertNoInteractiveChallenge(page,'flight-history-recovery:restore');
      await openFleetList(page,timeout);
    }catch{
      result.uiRestored=false;
    }
  }
  if(!result.uiRestored)throw new Error('FLIGHT_HISTORY_RECOVERY_LIST_RESTORE_FAILED_NO_MUTATIONS');
  return result;
}
