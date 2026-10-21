import { mkdir, open, readFile, rename, unlink } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { withRunLock } from '../utils/run-lock';
import { reviewEventId, RouteOptimizer, RoutePlan, RouteReview } from './route-optimizer';
import { routeReviewTrigger } from './review-schedule';
import type { AircraftSnapshot, CollectionResult } from '../demand/types';

type CompletedDecision = 'would_reroute' | 'keep_route' | 'hold';
interface RoutePerformanceEvidence { routeId:string; viable:boolean; netProfit:number|null; netProfitPerHour:number|null; occupancyPercentages:number[]; grossRevenueCeilingPerHour?:number }
interface Entry { aircraftId: string; origin: string; flightId: string; reviewedAt: string; decision: CompletedDecision;
  reviewEvidence?: { trigger:'return'|'daily'|'demand'; reviewedRouteId:string; selectedRouteId:string|null; result:CompletedDecision; routePerformance:RoutePerformanceEvidence[] } }
export interface FlightHistoryAnchorEvent { eventId:string; type:'flight-history-anchor'; aircraftId:string; registration:string; observedAt:string; cycles:number; rows:Array<{relativeTime:string;from:string;to:string;co2Quotas:number;onboard:{Y:number;J:number;F:number};fuelLbs:number;revenue:number}> }
export interface UncertainDepartureEvent { eventId:string; type:'departure-uncertain'; aircraftId:string; registration:string; routeId:string; from:string; to:string; observedAt:string; result:'outcome_unknown'; reason:string; sourceRunId:string }
export interface ResolvedUncertainDepartureEvent { eventId:string; type:'departure-uncertain-resolved'; uncertainEventId:string; aircraftId:string; registration:string; routeId:string; from:string; to:string; observedAt:string; result:'live_state_verified'; liveState:'ready'|'inflight'; reason:'STRICTLY_NEWER_VERIFIED_LIVE_STATE' }
export interface UncertainSupplyEvent { eventId:string; type:'supply-uncertain'; kind:'fuel'|'co2'; observedAt:string; result:'outcome_unknown'; reason:string; sourceRunId:string; pricePer1000:number; quantity:number; quotedCost:number }
export interface UncertainRouteEvent { eventId:string; type:'route-uncertain'; aircraftId:string; registration:string; previousRouteId:string; previousFrom:string; previousTo:string; targetFrom:string; targetTo:string; targetAirportId:string; observedAt:string; result:'outcome_unknown'; reason:'NO_RETRY_AFTER_ROUTE_MUTATION_ATTEMPT'; sourceRunId:string }
export interface UncertainPricingEvent { eventId:string; type:'pricing-uncertain'; aircraftId:string; registration:string; routeId:string; observedAt:string; result:'outcome_unknown'; reason:'NO_RETRY_AFTER_PRICE_SAVE_ATTEMPT'; sourceRunId:string; before:{Y:number;J:number;F:number}; desired:{Y:number;J:number;F:number} }
export interface ArrivalObservationEvent { eventId:string; type:'arrival-observed'; departureEventId:string; aircraftId:string; registration:string; routeId:string; from:string; to:string; departedAt:string; observedAt:string; result:'arrived_observed' }
export interface DepartureHistoryEvent { eventId:string; type:'departure'; aircraftId:string; registration:string; routeId:string; from:string; to:string; observedAt:string; result:'departed'; demand:{ availableBefore:{Y:number;J:number;F:number}; possiblePassengers:{Y:number;J:number;F:number}; occupancyPercentage:number }; actualOnboard:{Y:number;J:number;F:number} }
export interface SupplyObservationEvent { eventId:string; type:'supply-observation'; kind:'fuel'|'co2'; observedAt:string; pricePer1000:number; holding:number; remainingCapacity:number; balance:number }
export interface UiHealthObservation { eventId:string; type:'ui-health'; observedAt:string; status:'healthy'; surfaces:string[] }
export interface DemandHoldObservation { eventId:string; type:'demand-hold'; aircraftId:string; routeId:string; observedAt:string; occupancyPercentage:number; reason:'hold_insufficient' }
export interface DeferredDispatchEvent { eventId:string; type:'dispatch-deferred'|'dispatch-deferred-rechecked'; aircraftId:string; routeId:string; observedAt:string; sourceRunId:string; reason:'RUN_TIME_BUDGET_EXHAUSTED_BEFORE_EVALUATION'|'RUN_TIME_BUDGET_EXHAUSTED_BEFORE_MUTATION'|'REEVALUATED_IN_NEW_RUN' }
export interface Journal { schemaVersion: 1; scope: string; entries: Entry[]; events?:Array<DepartureHistoryEvent|FlightHistoryAnchorEvent|UncertainDepartureEvent|ResolvedUncertainDepartureEvent|UncertainSupplyEvent|UncertainRouteEvent|UncertainPricingEvent|ArrivalObservationEvent|DeferredDispatchEvent>; supplyObservations?:SupplyObservationEvent[]; holdObservations?:DemandHoldObservation[]; uiHealthObservations?:UiHealthObservation[] }
export interface JournalOptions {
  /** Durable directory supplied by the caller; ephemeral Actions runners require explicit transport. */
  directory: string;
  /** Non-secret company/environment identifier. A journal cannot be reused across scopes. */
  scope: string;
  origin: string;
  minOccupancy?: number;
  minImprovementPercent?: number;
  maxAgeSeconds?: number;
}
const completed = (d: string): d is CompletedDecision => ['would_reroute', 'keep_route', 'hold'].includes(d);
// Flight-history anchors are diagnostic/read-only evidence. Keep a large transport
// reserve for safety-critical departure, route, pricing and supply events.
const FLIGHT_HISTORY_ANCHOR_BUDGET_BYTES = 650000;
const validId = (v: unknown): v is string => typeof v === 'string' && /^[A-Za-z0-9_-]{1,100}$/.test(v);
const validOrigin = (v: unknown): v is string => typeof v === 'string' && /^[A-Z]{3}$/.test(v);
const key = (e: Pick<Entry, 'aircraftId' | 'origin' | 'flightId'>) => JSON.stringify([e.aircraftId, e.origin, e.flightId]);
const validPerformance=(v:unknown):v is RoutePerformanceEvidence=>{
  if(!v||typeof v!=='object')return false;const x=v as RoutePerformanceEvidence;
  const keys=Object.keys(x).sort().join(',');
  if(!['netProfit,netProfitPerHour,occupancyPercentages,routeId,viable',
    'grossRevenueCeilingPerHour,netProfit,netProfitPerHour,occupancyPercentages,routeId,viable'].includes(keys))return false;
  return validId(x.routeId)&&typeof x.viable==='boolean'&&
    (x.netProfit===null||Number.isFinite(x.netProfit))&&(x.netProfitPerHour===null||Number.isFinite(x.netProfitPerHour))&&
    (x.grossRevenueCeilingPerHour===undefined||(Number.isFinite(x.grossRevenueCeilingPerHour)&&x.grossRevenueCeilingPerHour>0))&&
    Array.isArray(x.occupancyPercentages)&&x.occupancyPercentages.length<=2&&
    x.occupancyPercentages.every(n=>Number.isFinite(n)&&n>=0&&n<=100);
};
const validReviewEvidence=(v:unknown,decision:CompletedDecision)=>{
  if(!v||typeof v!=='object')return false;const x=v as NonNullable<Entry['reviewEvidence']>;
  return Object.keys(x).sort().join(',')==='result,reviewedRouteId,routePerformance,selectedRouteId,trigger'&&['return','daily','demand'].includes(x.trigger)&&
    validId(x.reviewedRouteId)&&(x.selectedRouteId===null||validId(x.selectedRouteId))&&x.result===decision&&Array.isArray(x.routePerformance)&&
    x.routePerformance.length>0&&x.routePerformance.length<=100&&x.routePerformance.every(validPerformance);
};
const validCabins=(v:any)=>v&&typeof v==='object'&&Object.keys(v).sort().join(',')==='F,J,Y'&&['Y','J','F'].every(k=>Number.isSafeInteger(v[k])&&v[k]>=0);
const validFlightHistoryAnchor=(v:unknown,now:Date):v is FlightHistoryAnchorEvent=>{if(!v||typeof v!=='object')return false;const x=v as FlightHistoryAnchorEvent;if(Object.keys(x).sort().join(',')!=='aircraftId,cycles,eventId,observedAt,registration,rows,type'||!validId(x.eventId)||x.type!=='flight-history-anchor'||!validId(x.aircraftId)||typeof x.registration!=='string'||!x.registration||x.registration.length>100||typeof x.observedAt!=='string'||!Number.isFinite(Date.parse(x.observedAt))||Date.parse(x.observedAt)>now.getTime()||!Number.isSafeInteger(x.cycles)||x.cycles<0||!Array.isArray(x.rows)||x.rows.length<1||x.rows.length>8)return false;return x.rows.every(r=>r&&typeof r==='object'&&Object.keys(r).sort().join(',')==='co2Quotas,from,fuelLbs,onboard,relativeTime,revenue,to'&&typeof r.relativeTime==='string'&&r.relativeTime.length>0&&r.relativeTime.length<=40&&validOrigin(r.from)&&validOrigin(r.to)&&r.from!==r.to&&Number.isSafeInteger(r.co2Quotas)&&r.co2Quotas>=0&&validCabins(r.onboard)&&Number.isSafeInteger(r.fuelLbs)&&r.fuelLbs>=0&&Number.isSafeInteger(r.revenue)&&r.revenue>=0);};
export interface FlightHistoryContinuityDiagnostic { status:'verified_overlap'|'unavailable'; aircraftId:string; previousObservedAt:string|null; currentObservedAt:string|null; cycleDelta:number|null; overlapRows:number; previousStart:number|null; currentStart:number|null; cycleAligned:boolean; reason:string; comparisonReady:false; mutationAuthorized:false }
const flightHistoryRowIdentity=(r:FlightHistoryAnchorEvent['rows'][number])=>JSON.stringify([r.from,r.to,r.co2Quotas,r.onboard.Y,r.onboard.J,r.onboard.F,r.fuelLbs,r.revenue]);
/** Read-only evidence that two persisted snapshots contain the same completed flights. Never authorizes demand reconstruction by itself. */
export function compareFlightHistoryAnchors(previous:FlightHistoryAnchorEvent,current:FlightHistoryAnchorEvent):FlightHistoryContinuityDiagnostic{
 const base:FlightHistoryContinuityDiagnostic={status:'unavailable',aircraftId:current?.aircraftId||'',previousObservedAt:previous?.observedAt||null,currentObservedAt:current?.observedAt||null,cycleDelta:null,overlapRows:0,previousStart:null,currentStart:null,cycleAligned:false,reason:'ANCHOR_CONTINUITY_UNAVAILABLE',comparisonReady:false,mutationAuthorized:false};
 if(!previous||!current||previous.type!=='flight-history-anchor'||current.type!=='flight-history-anchor'||previous.aircraftId!==current.aircraftId||previous.registration!==current.registration)return {...base,reason:'ANCHOR_IDENTITY_MISMATCH'};
 const pTime=Date.parse(previous.observedAt),cTime=Date.parse(current.observedAt);if(!Number.isFinite(pTime)||!Number.isFinite(cTime)||cTime<=pTime)return {...base,reason:'ANCHOR_TIME_NOT_MONOTONIC'};
 if(!Number.isSafeInteger(previous.cycles)||!Number.isSafeInteger(current.cycles)||current.cycles<previous.cycles)return {...base,reason:'ANCHOR_CYCLES_NOT_MONOTONIC'};
 const p=previous.rows.map(flightHistoryRowIdentity),c=current.rows.map(flightHistoryRowIdentity);
 const alignments:Array<{i:number;j:number;length:number}>=[];for(let i=0;i<p.length;i++)for(let j=0;j<c.length;j++){let n=0;while(i+n<p.length&&j+n<c.length&&p[i+n]===c[j+n])n++;if(n>0)alignments.push({i,j,length:n});}
 const cycleDelta=current.cycles-previous.cycles,overlap=alignments.reduce((m,x)=>Math.max(m,x.length),0);
 if(overlap<2)return {...base,cycleDelta,overlapRows:overlap,reason:'ANCHOR_OVERLAP_INSUFFICIENT'};
 const best=alignments.filter(x=>x.length===overlap);
 if(best.length!==1)return {...base,cycleDelta,overlapRows:overlap,reason:'ANCHOR_OVERLAP_ALIGNMENT_AMBIGUOUS'};
 const alignment=best[0],cycleAligned=alignment.i===0&&alignment.j===cycleDelta;
 return {...base,status:'verified_overlap',cycleDelta,overlapRows:overlap,previousStart:alignment.i,currentStart:alignment.j,cycleAligned,reason:'PERSISTED_FLIGHT_ROWS_OVERLAP_VERIFIED'};
}
export function flightHistoryContinuityDiagnostics(journal:Journal):FlightHistoryContinuityDiagnostic[]{
 const grouped=new Map<string,FlightHistoryAnchorEvent[]>();
 for(const e of journal.events||[])if(e.type==='flight-history-anchor'){const a=grouped.get(e.aircraftId)||[];a.push(e);grouped.set(e.aircraftId,a);}
 const out:FlightHistoryContinuityDiagnostic[]=[];
 for(const anchors of grouped.values()){
  anchors.sort((a,b)=>Date.parse(a.observedAt)-Date.parse(b.observedAt));
  if(anchors.length<2)continue;
  out.push(compareFlightHistoryAnchors(anchors.at(-2)!,anchors.at(-1)!));
 }
 return out.sort((a,b)=>a.aircraftId.localeCompare(b.aircraftId));
}
export async function readFlightHistoryContinuityDiagnostics(directory:string,scope:string,now=new Date()):Promise<FlightHistoryContinuityDiagnostic[]>{
 const journal=validateReturnJournal(JSON.parse(await readFile(join(directory,'return-journal.json'),'utf8')),scope,now);
 return flightHistoryContinuityDiagnostics(journal);
}

export interface StitchedFlightHistoryRow {
  from:string;to:string;co2Quotas:number;onboard:{Y:number;J:number;F:number};fuelLbs:number;revenue:number;
  sourceObservedAt:string;sourceRelativeTime:string;ageLowerMinutes:number;ageUpperMinutes:number;
}
export interface FlightHistoryStitchDiagnostic {
  status:'verified_chain'|'unavailable';aircraftId:string;registration:string|null;anchorsAvailable:number;anchorsUsed:number;linksVerified:number;
  latestObservedAt:string|null;latestCycles:number|null;rowsStitched:number;oldestAgeLowerMinutes:number|null;oldestAgeUpperMinutes:number|null;
  stoppedReason:string|null;reason:string;rows:StitchedFlightHistoryRow[];comparisonReady:false;mutationAuthorized:false;
}
export function relativeAgeIntervalMinutes(text:string):{lower:number;upper:number}|null{
 const s=text.trim().toLowerCase();let m=s.match(/^(\d+) (?:seconds?|secs?) ago$/);
 if(m){const n=Number(m[1]);return {lower:n/60,upper:(n+1)/60};}
 m=s.match(/^(\d+) (?:minutes?|mins?) ago$/);if(m){const n=Number(m[1]);return {lower:n,upper:n+1};}
 m=s.match(/^(\d+) (?:hours?|hrs?) ago$/);if(m){const n=Number(m[1]);return {lower:n*60,upper:(n+1)*60};}
 m=s.match(/^(\d+) days? ago$/);if(m){const n=Number(m[1]);return {lower:n*1440,upper:(n+1)*1440};}
 if(s==='a second ago'||s==='1 second ago')return {lower:1/60,upper:2/60};
 if(s==='a minute ago'||s==='1 minute ago')return {lower:1,upper:2};
 if(s==='an hour ago'||s==='1 hour ago')return {lower:60,upper:120};
 if(s==='a day ago'||s==='1 day ago')return {lower:1440,upper:2880};
 return null;
}
const intervalsOverlap=(a:{lower:number;upper:number},b:{lower:number;upper:number})=>Math.max(a.lower,b.lower)<=Math.min(a.upper,b.upper);
const rebasedStitchRow=(r:FlightHistoryAnchorEvent['rows'][number],sourceObservedAt:string,latestObservedAt:string):StitchedFlightHistoryRow|null=>{
 const interval=relativeAgeIntervalMinutes(r.relativeTime),source=Date.parse(sourceObservedAt),latest=Date.parse(latestObservedAt);
 if(!interval||!Number.isFinite(source)||!Number.isFinite(latest)||latest<source)return null;
 const elapsed=(latest-source)/60000;
 return {from:r.from,to:r.to,co2Quotas:r.co2Quotas,onboard:{...r.onboard},fuelLbs:r.fuelLbs,revenue:r.revenue,
   sourceObservedAt,sourceRelativeTime:r.relativeTime,ageLowerMinutes:interval.lower+elapsed,ageUpperMinutes:interval.upper+elapsed};
};
/**
 * Builds only a read-only, cryptographically-persisted continuity view. It does not
 * feed candidate demand yet. A link is accepted only when the unique overlap starts
 * at the older snapshot's newest row, shifts by exactly the observed cycle delta,
 * and the coarse relative-age intervals remain compatible after elapsed time.
 */
export function buildConservativeFlightHistoryStitch(anchors:FlightHistoryAnchorEvent[]):FlightHistoryStitchDiagnostic{
 const sorted=[...anchors].sort((a,b)=>Date.parse(a.observedAt)-Date.parse(b.observedAt));
 const latest=sorted.at(-1);
 const base:FlightHistoryStitchDiagnostic={status:'unavailable',aircraftId:latest?.aircraftId||'',registration:latest?.registration||null,
   anchorsAvailable:sorted.length,anchorsUsed:latest?1:0,linksVerified:0,latestObservedAt:latest?.observedAt||null,latestCycles:latest?.cycles??null,
   rowsStitched:0,oldestAgeLowerMinutes:null,oldestAgeUpperMinutes:null,stoppedReason:null,reason:'STITCH_CONTINUITY_UNAVAILABLE',rows:[],comparisonReady:false,mutationAuthorized:false};
 if(!latest||sorted.length<2)return base;
 if(sorted.some(a=>a.aircraftId!==latest.aircraftId||a.registration!==latest.registration))return {...base,reason:'STITCH_IDENTITY_MISMATCH'};
 const rows:StitchedFlightHistoryRow[]=[];
 for(const r of latest.rows){const x=rebasedStitchRow(r,latest.observedAt,latest.observedAt);if(!x)return {...base,reason:'STITCH_LATEST_AGE_UNPARSEABLE'};rows.push(x);}
 let linksVerified=0,anchorsUsed=1,stoppedReason:string|null=null;
 for(let i=sorted.length-1;i>0;i--){
   const previous=sorted[i-1],current=sorted[i],link=compareFlightHistoryAnchors(previous,current);
   if(link.status!=='verified_overlap'){stoppedReason=link.reason;break;}
   if(!link.cycleAligned||link.previousStart!==0||link.currentStart!==link.cycleDelta){stoppedReason='STITCH_CYCLE_ALIGNMENT_UNVERIFIED';break;}
   const elapsed=(Date.parse(current.observedAt)-Date.parse(previous.observedAt))/60000;
   let ageCompatible=true;
   for(let n=0;n<link.overlapRows;n++){
     const p=relativeAgeIntervalMinutes(previous.rows[n].relativeTime);
     const c=relativeAgeIntervalMinutes(current.rows[link.currentStart!+n].relativeTime);
     if(!p||!c||!Number.isFinite(elapsed)||elapsed<0||!intervalsOverlap({lower:p.lower+elapsed,upper:p.upper+elapsed},c)){ageCompatible=false;break;}
   }
   if(!ageCompatible){stoppedReason='STITCH_OVERLAP_AGE_INCONSISTENT';break;}
   const tail=previous.rows.slice(link.overlapRows);
   const converted:StitchedFlightHistoryRow[]=[];
   for(const r of tail){const x=rebasedStitchRow(r,previous.observedAt,latest.observedAt);if(!x){ageCompatible=false;break;}converted.push(x);}
   if(!ageCompatible){stoppedReason='STITCH_TAIL_AGE_UNPARSEABLE';break;}
   const last=rows.at(-1);if(last&&converted.some((x,index)=>index===0&&x.ageUpperMinutes<last.ageLowerMinutes)){stoppedReason='STITCH_AGE_ORDER_INCONSISTENT';break;}
   rows.push(...converted);linksVerified++;anchorsUsed++;
 }
 if(!linksVerified)return {...base,rows,rowsStitched:rows.length,stoppedReason,reason:stoppedReason||base.reason};
 const oldest=rows.reduce((a,b)=>a.ageLowerMinutes>=b.ageLowerMinutes?a:b);
 return {...base,status:'verified_chain',anchorsUsed,linksVerified,rowsStitched:rows.length,rows,
   oldestAgeLowerMinutes:oldest.ageLowerMinutes,oldestAgeUpperMinutes:oldest.ageUpperMinutes,stoppedReason,
   reason:stoppedReason?'PERSISTED_FLIGHT_HISTORY_STITCH_VERIFIED_PARTIAL':'PERSISTED_FLIGHT_HISTORY_STITCH_VERIFIED'};
}
export function flightHistoryStitchDiagnostics(journal:Journal):FlightHistoryStitchDiagnostic[]{
 const grouped=new Map<string,FlightHistoryAnchorEvent[]>();
 for(const e of journal.events||[])if(e.type==='flight-history-anchor'){const list=grouped.get(e.aircraftId)||[];list.push(e);grouped.set(e.aircraftId,list);}
 return [...grouped.values()].map(buildConservativeFlightHistoryStitch).sort((a,b)=>a.aircraftId.localeCompare(b.aircraftId));
}
export async function readFlightHistoryStitchDiagnostics(directory:string,scope:string,now=new Date()):Promise<FlightHistoryStitchDiagnostic[]>{
 const journal=validateReturnJournal(JSON.parse(await readFile(join(directory,'return-journal.json'),'utf8')),scope,now);
 return flightHistoryStitchDiagnostics(journal);
}

export interface LiveAnchoredFlightHistoryStitchDiagnostic extends FlightHistoryStitchDiagnostic {
 liveAnchorVerified:boolean;
 persistedAnchorsAvailable:number;
 currentObservedAt:string|null;
 currentCycles:number|null;
}
const unavailableLiveStitch=(aircraft:AircraftSnapshot,reason:string,persistedAnchorsAvailable=0):LiveAnchoredFlightHistoryStitchDiagnostic=>({
 status:'unavailable',aircraftId:aircraft.aircraftId||'',registration:aircraft.registration||null,anchorsAvailable:persistedAnchorsAvailable,anchorsUsed:0,linksVerified:0,
 latestObservedAt:null,latestCycles:null,rowsStitched:0,oldestAgeLowerMinutes:null,oldestAgeUpperMinutes:null,stoppedReason:null,reason,rows:[],
 comparisonReady:false,mutationAuthorized:false,liveAnchorVerified:false,persistedAnchorsAvailable,currentObservedAt:aircraft.flightHistory?.observedAt||null,currentCycles:aircraft.operational?.cycles??null
});
const liveAnchorFromAircraft=(aircraft:AircraftSnapshot,now:Date):FlightHistoryAnchorEvent|null=>{
 const h=aircraft.flightHistory,cycles=aircraft.operational?.cycles;
 if(!aircraft.aircraftId||!aircraft.registration||!h||h.status!=='observed'||!Array.isArray(h.entries)||!h.entries.length||
   !Number.isSafeInteger(cycles)||cycles!<0||!Number.isFinite(Date.parse(h.observedAt))||Date.parse(h.observedAt)>now.getTime())return null;
 const rows=h.entries.slice(-8).map(r=>({relativeTime:r.relativeTime,from:r.from,to:r.to,co2Quotas:r.co2Quotas,onboard:{...r.onboard},fuelLbs:r.fuelLbs,revenue:r.revenue}));
 const event:FlightHistoryAnchorEvent={eventId:`live_${aircraft.aircraftId}`,type:'flight-history-anchor',aircraftId:aircraft.aircraftId,registration:aircraft.registration,observedAt:h.observedAt,cycles:cycles!,rows};
 return validFlightHistoryAnchor(event,now)?event:null;
};
const sameAnchorPayload=(a:FlightHistoryAnchorEvent,b:FlightHistoryAnchorEvent)=>a.observedAt===b.observedAt&&a.cycles===b.cycles&&
 a.rows.length===b.rows.length&&a.rows.every((r,i)=>flightHistoryRowIdentity(r)===flightHistoryRowIdentity(b.rows[i]));
const sameCompletedFlightHistory=(a:FlightHistoryAnchorEvent,b:FlightHistoryAnchorEvent)=>a.cycles===b.cycles&&
 a.rows.length===b.rows.length&&a.rows.every((r,i)=>flightHistoryRowIdentity(r)===flightHistoryRowIdentity(b.rows[i]));
/**
 * Extends persisted continuity only when the current live Flight History is itself
 * a valid newest anchor. This remains diagnostic-only: it cannot authorize route
 * comparison or mutation and does not alter candidate remaining demand.
 */
export function buildLiveAnchoredFlightHistoryStitch(journal:Journal,aircraft:AircraftSnapshot,now=new Date()):LiveAnchoredFlightHistoryStitchDiagnostic{
 const persisted=(journal.events||[]).filter((e):e is FlightHistoryAnchorEvent=>e.type==='flight-history-anchor'&&e.aircraftId===aircraft.aircraftId&&e.registration===aircraft.registration)
   .sort((a,b)=>Date.parse(a.observedAt)-Date.parse(b.observedAt));
 const live=liveAnchorFromAircraft(aircraft,now);
 if(!live)return unavailableLiveStitch(aircraft,'LIVE_FLIGHT_HISTORY_ANCHOR_UNAVAILABLE',persisted.length);
 if(persisted.some(a=>Date.parse(a.observedAt)>Date.parse(live.observedAt)))return unavailableLiveStitch(aircraft,'LIVE_ANCHOR_OLDER_THAN_PERSISTED',persisted.length);
 const sameTime=persisted.filter(a=>a.observedAt===live.observedAt);
 if(sameTime.some(a=>!sameAnchorPayload(a,live)))return unavailableLiveStitch(aircraft,'LIVE_ANCHOR_CONFLICTS_WITH_PERSISTED',persisted.length);
 const exact=sameTime.find(a=>sameAnchorPayload(a,live));
 const older=persisted.filter(a=>Date.parse(a.observedAt)<Date.parse(live.observedAt));
 const chain=exact?[...older,exact]:[...older,live];
 const stitched=buildConservativeFlightHistoryStitch(chain);
 return {...stitched,liveAnchorVerified:true,persistedAnchorsAvailable:persisted.length,currentObservedAt:live.observedAt,currentCycles:live.cycles,
   reason:stitched.status==='verified_chain'?'LIVE_ANCHORED_FLIGHT_HISTORY_STITCH_VERIFIED':stitched.reason};
}
export function liveAnchoredFlightHistoryStitchDiagnostics(journal:Journal,aircraft:AircraftSnapshot[],now=new Date()):LiveAnchoredFlightHistoryStitchDiagnostic[]{
 return aircraft.map(a=>buildLiveAnchoredFlightHistoryStitch(journal,a,now)).sort((a,b)=>a.aircraftId.localeCompare(b.aircraftId));
}
export async function readLiveAnchoredFlightHistoryStitchDiagnostics(directory:string,scope:string,aircraft:AircraftSnapshot[],now=new Date()):Promise<LiveAnchoredFlightHistoryStitchDiagnostic[]>{
 const journal=validateReturnJournal(JSON.parse(await readFile(join(directory,'return-journal.json'),'utf8')),scope,now);
 return liveAnchoredFlightHistoryStitchDiagnostics(journal,aircraft,now);
}
const validUncertainDepartureEvent=(v:unknown,now:Date):v is UncertainDepartureEvent=>{if(!v||typeof v!=='object')return false;const x=v as UncertainDepartureEvent;return Object.keys(x).sort().join(',')==='aircraftId,eventId,from,observedAt,reason,registration,result,routeId,sourceRunId,to,type'&&validId(x.eventId)&&x.type==='departure-uncertain'&&validId(x.aircraftId)&&typeof x.registration==='string'&&x.registration.length>0&&x.registration.length<=100&&validId(x.routeId)&&validOrigin(x.from)&&validOrigin(x.to)&&x.from!==x.to&&typeof x.observedAt==='string'&&Number.isFinite(Date.parse(x.observedAt))&&Date.parse(x.observedAt)<=now.getTime()&&x.result==='outcome_unknown'&&/^[A-Z0-9_:-]{1,160}$/.test(x.reason)&&validId(x.sourceRunId);};
const validResolvedUncertainDepartureEvent=(v:unknown,now:Date):v is ResolvedUncertainDepartureEvent=>{if(!v||typeof v!=='object')return false;const x=v as ResolvedUncertainDepartureEvent;return Object.keys(x).sort().join(',')==='aircraftId,eventId,from,liveState,observedAt,reason,registration,result,routeId,to,type,uncertainEventId'&&validId(x.eventId)&&x.type==='departure-uncertain-resolved'&&validId(x.uncertainEventId)&&validId(x.aircraftId)&&typeof x.registration==='string'&&x.registration.length>0&&x.registration.length<=100&&validId(x.routeId)&&validOrigin(x.from)&&validOrigin(x.to)&&x.from!==x.to&&typeof x.observedAt==='string'&&Number.isFinite(Date.parse(x.observedAt))&&Date.parse(x.observedAt)<=now.getTime()&&x.result==='live_state_verified'&&['ready','inflight'].includes(x.liveState)&&x.reason==='STRICTLY_NEWER_VERIFIED_LIVE_STATE';};
export function unresolvedDepartureKeys(journal:Journal):ReadonlySet<string>{
  const resolved=new Set((journal.events||[]).filter((e):e is ResolvedUncertainDepartureEvent=>e.type==='departure-uncertain-resolved').map(e=>e.uncertainEventId));
  return new Set((journal.events||[]).filter((e):e is UncertainDepartureEvent=>e.type==='departure-uncertain'&&!resolved.has(e.eventId)).map(e=>e.aircraftId+':'+e.routeId));
}
export async function readUnresolvedDepartureKeys(directory:string,scope:string,now=new Date()):Promise<ReadonlySet<string>>{return unresolvedDepartureKeys(validateReturnJournal(JSON.parse(await readFile(join(directory,'return-journal.json'),'utf8')),scope,now));}
const validUncertainSupplyEvent=(v:unknown,now:Date):v is UncertainSupplyEvent=>{if(!v||typeof v!=='object')return false;const x=v as UncertainSupplyEvent;return Object.keys(x).sort().join(',')==='eventId,kind,observedAt,pricePer1000,quantity,quotedCost,reason,result,sourceRunId,type'&&validId(x.eventId)&&x.type==='supply-uncertain'&&['fuel','co2'].includes(x.kind)&&typeof x.observedAt==='string'&&Number.isFinite(Date.parse(x.observedAt))&&Date.parse(x.observedAt)<=now.getTime()&&x.result==='outcome_unknown'&&/^[A-Z0-9_:-]{1,160}$/.test(x.reason)&&validId(x.sourceRunId)&&Number.isSafeInteger(x.pricePer1000)&&x.pricePer1000>0&&Number.isSafeInteger(x.quantity)&&x.quantity>0&&Number.isSafeInteger(x.quotedCost)&&x.quotedCost>0;};
const validUncertainRouteEvent=(v:unknown,now:Date):v is UncertainRouteEvent=>{if(!v||typeof v!=='object')return false;const x=v as UncertainRouteEvent;return Object.keys(x).sort().join(',')==='aircraftId,eventId,observedAt,previousFrom,previousRouteId,previousTo,reason,registration,result,sourceRunId,targetAirportId,targetFrom,targetTo,type'&&validId(x.eventId)&&x.type==='route-uncertain'&&validId(x.aircraftId)&&typeof x.registration==='string'&&x.registration.length>0&&x.registration.length<=100&&validId(x.previousRouteId)&&validOrigin(x.previousFrom)&&validOrigin(x.previousTo)&&x.previousFrom!==x.previousTo&&validOrigin(x.targetFrom)&&validOrigin(x.targetTo)&&x.targetFrom!==x.targetTo&&validId(x.targetAirportId)&&typeof x.observedAt==='string'&&Number.isFinite(Date.parse(x.observedAt))&&Date.parse(x.observedAt)<=now.getTime()&&x.result==='outcome_unknown'&&x.reason==='NO_RETRY_AFTER_ROUTE_MUTATION_ATTEMPT'&&validId(x.sourceRunId);};
const validUncertainPricingEvent=(v:unknown,now:Date):v is UncertainPricingEvent=>{if(!v||typeof v!=='object')return false;const x=v as UncertainPricingEvent;return Object.keys(x).sort().join(',')==='aircraftId,before,desired,eventId,observedAt,reason,registration,result,routeId,sourceRunId,type'&&validId(x.eventId)&&x.type==='pricing-uncertain'&&validId(x.aircraftId)&&typeof x.registration==='string'&&x.registration.length>0&&x.registration.length<=100&&validId(x.routeId)&&typeof x.observedAt==='string'&&Number.isFinite(Date.parse(x.observedAt))&&Date.parse(x.observedAt)<=now.getTime()&&x.result==='outcome_unknown'&&x.reason==='NO_RETRY_AFTER_PRICE_SAVE_ATTEMPT'&&validId(x.sourceRunId)&&validCabins(x.before)&&validCabins(x.desired);};
const validArrivalObservationEvent=(v:unknown,now:Date):v is ArrivalObservationEvent=>{if(!v||typeof v!=='object')return false;const x=v as ArrivalObservationEvent;const departed=Date.parse(x.departedAt),observed=Date.parse(x.observedAt);return Object.keys(x).sort().join(',')==='aircraftId,departedAt,departureEventId,eventId,from,observedAt,registration,result,routeId,to,type'&&validId(x.eventId)&&x.type==='arrival-observed'&&validId(x.departureEventId)&&validId(x.aircraftId)&&typeof x.registration==='string'&&x.registration.length>0&&x.registration.length<=100&&validId(x.routeId)&&validOrigin(x.from)&&validOrigin(x.to)&&x.from!==x.to&&typeof x.departedAt==='string'&&typeof x.observedAt==='string'&&Number.isFinite(departed)&&Number.isFinite(observed)&&departed<observed&&observed<=now.getTime()&&x.result==='arrived_observed';};
export function unresolvedSupplyKinds(journal:Journal):ReadonlySet<'fuel'|'co2'>{
  const unresolved=new Set<'fuel'|'co2'>();
  for(const kind of ['fuel','co2'] as const){
    const latestUncertain=Math.max(0,...(journal.events||[])
      .filter((e):e is UncertainSupplyEvent=>e.type==='supply-uncertain'&&e.kind===kind)
      .map(e=>Date.parse(e.observedAt)||0));
    if(!latestUncertain)continue;
    const latestVerifiedSnapshot=Math.max(0,...(journal.supplyObservations||[])
      .filter(e=>e.kind===kind)
      .map(e=>Date.parse(e.observedAt)||0));
    // A strictly newer verified inventory snapshot reconciles the previous unknown outcome.
    // The uncertain event is intentionally retained for audit; only its blocking state is resolved.
    if(latestVerifiedSnapshot<=latestUncertain)unresolved.add(kind);
  }
  return unresolved;
}
export async function readUnresolvedSupplyKinds(directory:string,scope:string,now=new Date()):Promise<ReadonlySet<'fuel'|'co2'>>{return unresolvedSupplyKinds(validateReturnJournal(JSON.parse(await readFile(join(directory,'return-journal.json'),'utf8')),scope,now));}
export function unresolvedRouteAircraftIds(journal:Journal):ReadonlySet<string>{return new Set((journal.events||[]).filter((e):e is UncertainRouteEvent=>e.type==='route-uncertain').map(e=>e.aircraftId));}
export async function readUnresolvedRouteAircraftIds(directory:string,scope:string,now=new Date()):Promise<ReadonlySet<string>>{return unresolvedRouteAircraftIds(validateReturnJournal(JSON.parse(await readFile(join(directory,'return-journal.json'),'utf8')),scope,now));}
export function unresolvedPricingRouteIds(journal:Journal):ReadonlySet<string>{return new Set((journal.events||[]).filter((e):e is UncertainPricingEvent=>e.type==='pricing-uncertain').map(e=>e.routeId));}
export async function readUnresolvedPricingRouteIds(directory:string,scope:string,now=new Date()):Promise<ReadonlySet<string>>{return unresolvedPricingRouteIds(validateReturnJournal(JSON.parse(await readFile(join(directory,'return-journal.json'),'utf8')),scope,now));}
const validDeferredDispatchEvent=(v:unknown,now:Date):v is DeferredDispatchEvent=>{
 if(!v||typeof v!=='object')return false;
 const e=v as DeferredDispatchEvent;
 return Object.keys(e).sort().join(',')==='aircraftId,eventId,observedAt,reason,routeId,sourceRunId,type' &&
  validId(e.eventId)&&validId(e.aircraftId)&&validId(e.routeId)&&validId(e.sourceRunId) &&
  ['dispatch-deferred','dispatch-deferred-rechecked'].includes(e.type) &&
  (e.type==='dispatch-deferred'
   ?['RUN_TIME_BUDGET_EXHAUSTED_BEFORE_EVALUATION','RUN_TIME_BUDGET_EXHAUSTED_BEFORE_MUTATION'].includes(e.reason)
   :e.reason==='REEVALUATED_IN_NEW_RUN') &&
  typeof e.observedAt==='string'&&Number.isFinite(Date.parse(e.observedAt))&&Date.parse(e.observedAt)<=now.getTime();
};
const validDepartureEvent=(v:unknown,now:Date):v is DepartureHistoryEvent=>{
  if(!v||typeof v!=='object')return false;const x=v as DepartureHistoryEvent;
  return Object.keys(x).sort().join(',')==='actualOnboard,aircraftId,demand,eventId,from,observedAt,registration,result,routeId,to,type'&&validId(x.eventId)&&x.type==='departure'&&validId(x.aircraftId)&&
    typeof x.registration==='string'&&x.registration.length>0&&x.registration.length<=100&&validId(x.routeId)&&validOrigin(x.from)&&validOrigin(x.to)&&x.from!==x.to&&
    typeof x.observedAt==='string'&&Number.isFinite(Date.parse(x.observedAt))&&Date.parse(x.observedAt)<=now.getTime()&&x.result==='departed'&&
    x.demand&&Object.keys(x.demand).sort().join(',')==='availableBefore,occupancyPercentage,possiblePassengers'&&validCabins(x.demand.availableBefore)&&validCabins(x.demand.possiblePassengers)&&
    Number.isFinite(x.demand.occupancyPercentage)&&x.demand.occupancyPercentage>=0&&x.demand.occupancyPercentage<=100&&validCabins(x.actualOnboard);
};
const validHoldObservation=(v:unknown,now:Date):v is DemandHoldObservation=>{if(!v||typeof v!=='object')return false;const x=v as DemandHoldObservation;return Object.keys(x).sort().join(',')==='aircraftId,eventId,observedAt,occupancyPercentage,reason,routeId,type'&&validId(x.eventId)&&x.type==='demand-hold'&&validId(x.aircraftId)&&validId(x.routeId)&&typeof x.observedAt==='string'&&Number.isFinite(Date.parse(x.observedAt))&&Date.parse(x.observedAt)<=now.getTime()&&Number.isFinite(x.occupancyPercentage)&&x.occupancyPercentage>=0&&x.occupancyPercentage<=100&&x.reason==='hold_insufficient';};
const validUiHealthObservation=(v:unknown,now:Date):v is UiHealthObservation=>{if(!v||typeof v!=='object')return false;const x=v as UiHealthObservation;return Object.keys(x).sort().join(',')==='eventId,observedAt,status,surfaces,type'&&validId(x.eventId)&&x.type==='ui-health'&&x.status==='healthy'&&typeof x.observedAt==='string'&&Number.isFinite(Date.parse(x.observedAt))&&Date.parse(x.observedAt)<=now.getTime()&&Array.isArray(x.surfaces)&&x.surfaces.length===5&&x.surfaces.join(',')==='login,fleet,maintenance,marketing,supplies';};
const validSupplyObservation=(v:unknown,now:Date):v is SupplyObservationEvent=>{if(!v||typeof v!=='object')return false;const x=v as SupplyObservationEvent;return Object.keys(x).sort().join(',')==='balance,eventId,holding,kind,observedAt,pricePer1000,remainingCapacity,type'&&validId(x.eventId)&&x.type==='supply-observation'&&['fuel','co2'].includes(x.kind)&&typeof x.observedAt==='string'&&Number.isFinite(Date.parse(x.observedAt))&&Date.parse(x.observedAt)<=now.getTime()&&Number.isSafeInteger(x.pricePer1000)&&x.pricePer1000>0&&Number.isSafeInteger(x.holding)&&(x.kind==='co2'||x.holding>=0)&&Number.isSafeInteger(x.remainingCapacity)&&x.remainingCapacity>=0&&Number.isSafeInteger(x.balance)&&x.balance>=0;};
export function validateReturnJournal(value: unknown, scope: string, now: Date): Journal {
  const data = value as Journal;
  const topKeys=Object.keys(data||{}).sort().join(',');
  if (!data || typeof data !== 'object' || !['entries,schemaVersion,scope','entries,events,schemaVersion,scope','entries,schemaVersion,scope,supplyObservations','entries,events,schemaVersion,scope,supplyObservations','entries,holdObservations,schemaVersion,scope','entries,events,holdObservations,schemaVersion,scope','entries,holdObservations,schemaVersion,scope,supplyObservations','entries,events,holdObservations,schemaVersion,scope,supplyObservations','entries,schemaVersion,scope,uiHealthObservations','entries,events,schemaVersion,scope,uiHealthObservations','entries,schemaVersion,scope,supplyObservations,uiHealthObservations','entries,events,schemaVersion,scope,supplyObservations,uiHealthObservations','entries,holdObservations,schemaVersion,scope,uiHealthObservations','entries,events,holdObservations,schemaVersion,scope,uiHealthObservations','entries,holdObservations,schemaVersion,scope,supplyObservations,uiHealthObservations','entries,events,holdObservations,schemaVersion,scope,supplyObservations,uiHealthObservations'].includes(topKeys) || data.schemaVersion !== 1 || data.scope !== scope || !Array.isArray(data.entries) || data.entries.length > 100000 ||
      ('events' in data&&(!Array.isArray(data.events)||data.events.length>100000))||('uiHealthObservations' in data&&(!Array.isArray(data.uiHealthObservations)||data.uiHealthObservations.length>100000))||('supplyObservations' in data&&(!Array.isArray(data.supplyObservations)||data.supplyObservations.length>100000))||('holdObservations' in data&&(!Array.isArray(data.holdObservations)||data.holdObservations.length>100000))) throw new Error('JOURNAL_INVALID');
  const seen = new Set<string>();
  for (const e of data.entries) {
    const keys=Object.keys(e||{}).sort().join(',');
    if (!e || typeof e !== 'object' || !['aircraftId,decision,flightId,origin,reviewedAt','aircraftId,decision,flightId,origin,reviewEvidence,reviewedAt'].includes(keys) || !validId(e.aircraftId) || !validId(e.flightId) || !validOrigin(e.origin) || !completed(e.decision) ||
        typeof e.reviewedAt !== 'string' || !Number.isFinite(Date.parse(e.reviewedAt)) || Date.parse(e.reviewedAt) > now.getTime() || seen.has(key(e)) ||
        ('reviewEvidence' in e && !validReviewEvidence(e.reviewEvidence,e.decision))) throw new Error('JOURNAL_INVALID');
    seen.add(key(e));
  }
  const eventIds=new Set<string>();
  for(const e of data.events||[]){const type=(e as any)?.type;const ok=type==='departure'?validDepartureEvent(e,now):type==='departure-uncertain'?validUncertainDepartureEvent(e,now):type==='departure-uncertain-resolved'?validResolvedUncertainDepartureEvent(e,now):type==='supply-uncertain'?validUncertainSupplyEvent(e,now):type==='route-uncertain'?validUncertainRouteEvent(e,now):type==='pricing-uncertain'?validUncertainPricingEvent(e,now):type==='arrival-observed'?validArrivalObservationEvent(e,now):type==='flight-history-anchor'?validFlightHistoryAnchor(e,now):type==='dispatch-deferred'||type==='dispatch-deferred-rechecked'?validDeferredDispatchEvent(e,now):false;if(!ok||eventIds.has((e as any).eventId))throw new Error('JOURNAL_INVALID');eventIds.add((e as any).eventId);}
  for(const e of data.events||[])if(e.type==='arrival-observed'){const source=(data.events||[]).filter((x):x is DepartureHistoryEvent=>x.type==='departure'&&x.eventId===e.departureEventId);if(source.length!==1)throw new Error('JOURNAL_INVALID');const d=source[0];if(d.aircraftId!==e.aircraftId||d.registration!==e.registration||d.routeId!==e.routeId||d.from!==e.from||d.to!==e.to||d.observedAt!==e.departedAt)throw new Error('JOURNAL_INVALID');}
  for(const e of data.events||[])if(e.type==='departure-uncertain-resolved'){
    const source=(data.events||[]).filter((x):x is UncertainDepartureEvent=>x.type==='departure-uncertain'&&x.eventId===e.uncertainEventId);
    if(source.length!==1)throw new Error('JOURNAL_INVALID');
    const d=source[0],samePair=[d.from,d.to].sort().join(':')===[e.from,e.to].sort().join(':');
    if(d.aircraftId!==e.aircraftId||d.registration!==e.registration||d.routeId!==e.routeId||!samePair||Date.parse(e.observedAt)<=Date.parse(d.observedAt))throw new Error('JOURNAL_INVALID');
  }
  const uiIds=new Set<string>();for(const e of data.uiHealthObservations||[]){if(!validUiHealthObservation(e,now)||uiIds.has(e.eventId))throw new Error('JOURNAL_INVALID');uiIds.add(e.eventId);}
  const supplyIds=new Set<string>();for(const e of data.supplyObservations||[]){if(!validSupplyObservation(e,now)||supplyIds.has(e.eventId))throw new Error('JOURNAL_INVALID');supplyIds.add(e.eventId);}
  const holdIds=new Set<string>();for(const e of data.holdObservations||[]){if(!validHoldObservation(e,now)||holdIds.has(e.eventId))throw new Error('JOURNAL_INVALID');holdIds.add(e.eventId);}
  return data;
}
export async function appendFlightHistoryAnchors(directory:string,scope:string,runId:string,collection:any,coverage:any[],now=new Date()):Promise<number>{
 if(!validId(scope)||!validId(runId)||!Number.isFinite(now.getTime())||!collection||!Array.isArray(collection.aircraft)||!Array.isArray(coverage))throw new Error('JOURNAL_CONFIG_INVALID');
 const wanted=new Set(coverage.filter(x=>x?.coversReset===false&&x?.historyStatus==='observed'&&Number.isSafeInteger(x?.visibleEntries)&&x.visibleEntries>0).map(x=>x.aircraftId));if(!wanted.size)return 0;
 const root=resolve(directory);await mkdir(root,{recursive:true});return withRunLock(async()=>{const filename=join(root,'return-journal.json');let data:Journal;try{data=validateReturnJournal(JSON.parse(await readFile(filename,'utf8')),scope,now);}catch{throw new Error('JOURNAL_UNAVAILABLE: ancora de historico bloqueada.');}const list=data.events?[...data.events]:[];let added=0;
 for(const a of collection.aircraft){
  if(!wanted.has(a?.aircraftId)||a?.flightHistory?.status!=='observed'||!Number.isSafeInteger(a?.operational?.cycles)||a.operational.cycles<0)continue;
  const rows=(a.flightHistory.entries||[]).slice(-8).map((r:any)=>({relativeTime:r.relativeTime,from:r.from,to:r.to,co2Quotas:r.co2Quotas,onboard:{...r.onboard},fuelLbs:r.fuelLbs,revenue:r.revenue}));
  if(!rows.length)continue;
  const event:FlightHistoryAnchorEvent={eventId:`hist_${runId}_${a.aircraftId}`,type:'flight-history-anchor',aircraftId:a.aircraftId,registration:a.registration,observedAt:a.flightHistory.observedAt,cycles:a.operational.cycles,rows};
  if(!validFlightHistoryAnchor(event,now))throw new Error('JOURNAL_FLIGHT_HISTORY_ANCHOR_INVALID');
  if(list.some(x=>x.eventId===event.eventId))continue;
  const previous=list.filter((x):x is FlightHistoryAnchorEvent=>x.type==='flight-history-anchor'&&x.aircraftId===event.aircraftId&&x.registration===event.registration)
    .sort((x,y)=>Date.parse(x.observedAt)-Date.parse(y.observedAt)).at(-1);
  // Relative-age labels move as time passes. They are not new completed-flight evidence.
  // Persist only when cycles or the actual completed-flight rows changed.
  if(previous&&sameCompletedFlightHistory(previous,event))continue;
  const projected={...data,events:[...list,event]};
  if(Buffer.byteLength(JSON.stringify(projected))>FLIGHT_HISTORY_ANCHOR_BUDGET_BYTES)continue;
  list.push(event);added++;
 }
 if(!added)return 0;if(list.length>100000)throw new Error('JOURNAL_FULL: nao descartar historico automaticamente.');data.events=list;const temporary=join(root,`return-journal.${randomUUID()}.tmp`);try{const file=await open(temporary,'wx',0o600);try{await file.writeFile(JSON.stringify(data,null,2)+'\n');await file.sync();}finally{await file.close();}await rename(temporary,filename);}catch{throw new Error('JOURNAL_SAVE_FAILED: ancora de historico nao persistida.');}finally{await unlink(temporary).catch(()=>undefined);}return added;},join(root,'.return-journal.lock'));
}
export async function appendUiHealthObservation(directory:string,scope:string,observedAt:string,surfaces:string[]):Promise<number>{const now=new Date(observedAt);if(!validId(scope)||!Number.isFinite(now.getTime()))throw new Error('JOURNAL_CONFIG_INVALID');const root=resolve(directory);return withRunLock(async()=>{const filename=join(root,'return-journal.json');const data=validateReturnJournal(JSON.parse(await readFile(filename,'utf8')),scope,now);const list=data.uiHealthObservations?[...data.uiHealthObservations]:[];const event:UiHealthObservation={eventId:'ui_'+observedAt.replace(/\D/g,'').slice(0,14),type:'ui-health',observedAt,status:'healthy',surfaces:[...surfaces]};if(!validUiHealthObservation(event,now))throw new Error('JOURNAL_UI_HEALTH_INVALID');if(list.some(x=>x.eventId===event.eventId))return 0;list.push(event);data.uiHealthObservations=list;const temporary=join(root,`return-journal.${randomUUID()}.tmp`);try{const file=await open(temporary,'wx',0o600);try{await file.writeFile(JSON.stringify(data,null,2)+'\n');await file.sync();}finally{await file.close();}await rename(temporary,filename);}finally{await unlink(temporary).catch(()=>undefined);}return 1;},join(root,'.return-journal.lock'));}
export async function appendConfirmedRerouteReviews(directory:string,scope:string,decisions:any[],candidates:any[],fleet:any[],origins:ReadonlyMap<string,string>,execution:any,reviewTimeZone:string,now=new Date(),demandTriggeredAircraftIds:ReadonlySet<string>=new Set(),sourceRunId=''):Promise<number>{
 if(!validId(scope)||!Number.isFinite(now.getTime())||!Array.isArray(decisions)||!Array.isArray(candidates)||!Array.isArray(fleet)||!execution||execution.halted===true)throw new Error('JOURNAL_CONFIG_INVALID');
 const root=resolve(directory);await mkdir(root,{recursive:true});
 return withRunLock(async()=>{
  const filename=join(root,'return-journal.json');let data:Journal;
  try{data=validateReturnJournal(JSON.parse(await readFile(filename,'utf8')),scope,now);}
  catch{throw new Error('JOURNAL_UNAVAILABLE: historico de reroute bloqueado.');}
  let added=0;
  for(const d of decisions){
   if(d?.decision!=='would_reroute'||!d?.selected||!Number.isSafeInteger(d?.compared)||d.compared<1||
      !Number.isSafeInteger(d?.dominating)||d.dominating<1)continue;
   const matches=fleet.filter(a=>a?.aircraftId===d.aircraftId);if(matches.length!==1)continue;
   const a=matches[0],demandTriggered=demandTriggeredAircraftIds.has(a.aircraftId);
   const origin=demandTriggered?a.from:origins.get(a.aircraftId);
   if(!origin||!validOrigin(origin)||a.state!=='ready'||a.issue||(!demandTriggered&&a.from!==origin)||!validId(a.routeId))continue;
   const review=demandTriggered
     ? (validId(sourceRunId)?{due:true,trigger:'demand' as const,flightId:`demand_${sourceRunId}_${a.aircraftId}_${a.routeId}`}:null)
     : routeReviewTrigger(a.aircraftId,origin,data,now,reviewTimeZone);
   if(!review||!review.due||review.trigger==='none'||!review.flightId)continue;

   const done=(execution.entries||[]).filter((e:any)=>e?.aircraftId===a.aircraftId&&e?.status==='rerouted'&&
     e?.reason==='NATIVE_REROUTE_AND_FRESH_ROUTE_CONFIRMED'&&e.previousRouteId===a.routeId&&e.previousFrom===a.from&&
     e.previousTo===a.to&&e.targetFrom===d.selected.from&&e.targetTo===d.selected.to&&e.targetAirportId===d.selected.airportId&&
     validId(e.confirmedRouteId)&&e.confirmedRouteId!==a.routeId);
   if(done.length!==1)continue;

   const target=candidates.filter(c=>c?.aircraftId===a.aircraftId&&c?.from===d.selected.from&&c?.to===d.selected.to&&
     c?.airportId===d.selected.airportId&&c?.comparisonReady===true&&c?.variableCycleComparison?.comparisonReady===true&&
     c.variableCycleComparison.status==='candidate_dominates'&&c?.variableCycleComparison?.current?.comparisonReady===true&&
     c?.candidateVariableCycle?.comparisonReady===true);
   if(target.length!==1)continue;

   const v=target[0].variableCycleComparison,current=v.current,candidate=target[0].candidateVariableCycle;
   if(current.aircraftId!==a.aircraftId||current.from!==a.from||current.to!==a.to||
      candidate.aircraftId!==a.aircraftId||candidate.from!==d.selected.from||candidate.to!==d.selected.to)continue;
   const nums=[current.recurringCycleProfit?.expected,current.recurringCycleProfitPerHour?.expected,
     candidate.recurringCycleProfit?.expected,candidate.recurringCycleProfitPerHour?.expected];
   if(nums.some(n=>!Number.isFinite(n)))continue;

   const entry:Entry={aircraftId:a.aircraftId,origin,flightId:review.flightId,reviewedAt:now.toISOString(),decision:'would_reroute',
    reviewEvidence:{trigger:review.trigger,reviewedRouteId:a.routeId,selectedRouteId:done[0].confirmedRouteId,result:'would_reroute',
     routePerformance:[
      {routeId:a.routeId,viable:true,netProfit:current.recurringCycleProfit.expected,netProfitPerHour:current.recurringCycleProfitPerHour.expected,occupancyPercentages:[]},
      {routeId:done[0].confirmedRouteId,viable:true,netProfit:candidate.recurringCycleProfit.expected,netProfitPerHour:candidate.recurringCycleProfitPerHour.expected,occupancyPercentages:[]}
     ]}};
   if(data.entries.some(e=>key(e)===key(entry)))continue;
   if(!validReviewEvidence(entry.reviewEvidence,entry.decision))throw new Error('JOURNAL_REROUTE_REVIEW_INVALID');
   if(data.entries.length>=100000)throw new Error('JOURNAL_FULL: nao descartar historico automaticamente.');
   data.entries.push(entry);added++;
  }
  if(!added)return 0;
  const temporary=join(root,`return-journal.${randomUUID()}.tmp`);
  try{const f=await open(temporary,'wx',0o600);try{await f.writeFile(JSON.stringify(data,null,2)+'\n');await f.sync();}finally{await f.close();}await rename(temporary,filename);}
  catch{throw new Error('JOURNAL_SAVE_FAILED: reroute confirmado nao persistido.');}
  finally{await unlink(temporary).catch(()=>undefined);}
  return added;
 },join(root,'.return-journal.lock'));
}
export async function appendVerifiedKeepRouteDecisions(directory:string,scope:string,decisions:any[],candidates:any[],fleet:any[],origins:ReadonlyMap<string,string>,reviewTimeZone:string,now=new Date(),demandTriggeredAircraftIds:ReadonlySet<string>=new Set(),sourceRunId=''):Promise<number>{
 if(!validId(scope)||!Number.isFinite(now.getTime())||!Array.isArray(decisions)||!Array.isArray(candidates)||!Array.isArray(fleet))throw new Error('JOURNAL_CONFIG_INVALID');
 const root=resolve(directory);await mkdir(root,{recursive:true});return withRunLock(async()=>{
  const filename=join(root,'return-journal.json');let data:Journal;
  try{data=validateReturnJournal(JSON.parse(await readFile(filename,'utf8')),scope,now);}
  catch{throw new Error('JOURNAL_UNAVAILABLE: historico de revisao bloqueado.');}
  let added=0;
  for(const d of decisions){
   if(d?.decision!=='keep_route'||d?.selected!==null||!Number.isSafeInteger(d?.compared)||d.compared<1||
      d.reason!=='NO_INSPECTED_CANDIDATE_PROVES_CONSERVATIVE_DOMINANCE')continue;
   const matches=fleet.filter(a=>a?.aircraftId===d.aircraftId);if(matches.length!==1)continue;
   const a=matches[0],demandTriggered=demandTriggeredAircraftIds.has(a.aircraftId);
   const origin=demandTriggered?a.from:origins.get(a.aircraftId);
   if(!origin||!validOrigin(origin)||a.state!=='ready'||a.issue||(!demandTriggered&&a.from!==origin)||!validId(a.routeId))continue;
   const review=demandTriggered
     ? (validId(sourceRunId)?{due:true,trigger:'demand' as const,flightId:`demand_${sourceRunId}_${a.aircraftId}_${a.routeId}`}:null)
     : routeReviewTrigger(a.aircraftId,origin,data,now,reviewTimeZone);
   if(!review||!review.due||review.trigger==='none'||!review.flightId)continue;
   const comparable=candidates.filter(c=>c?.aircraftId===a.aircraftId&&c?.comparisonReady===true&&
     c?.variableCycleComparison?.comparisonReady===true&&c.variableCycleComparison.status==='keep_current');
   if(comparable.length!==d.compared)continue;

   const usesCeiling=comparable.some(c=>c.variableCycleComparison.comparisonBasis==='current_gross_revenue_ceiling');
   let performance:RoutePerformanceEvidence|null=null;
   if(usesCeiling){
    const ceilings=comparable.map(c=>c.variableCycleComparison.currentGrossRevenueCeiling);
    if(ceilings.some((x:any)=>x?.status!=='verified_ceiling'||x?.aircraftId!==a.aircraftId||x?.from!==a.from||
      x?.to!==a.to||!Number.isFinite(x?.grossRevenuePerHour)||x.grossRevenuePerHour<=0))continue;
    const perHour=ceilings[0].grossRevenuePerHour;
    if(ceilings.some((x:any)=>x.grossRevenuePerHour!==perHour))continue;
    performance={routeId:a.routeId,viable:true,netProfit:null,netProfitPerHour:null,
      occupancyPercentages:[],grossRevenueCeilingPerHour:perHour};
   }else{
    const current=comparable.map(c=>c.variableCycleComparison.current);
    if(current.some((x:any)=>x?.comparisonReady!==true||x?.aircraftId!==a.aircraftId||x?.from!==a.from||x?.to!==a.to||
      !Number.isFinite(x?.recurringCycleProfit?.expected)||!Number.isFinite(x?.recurringCycleProfitPerHour?.expected)))continue;
    const profit=current[0].recurringCycleProfit.expected,perHour=current[0].recurringCycleProfitPerHour.expected;
    if(current.some((x:any)=>x.recurringCycleProfit.expected!==profit||x.recurringCycleProfitPerHour.expected!==perHour))continue;
    performance={routeId:a.routeId,viable:true,netProfit:profit,netProfitPerHour:perHour,occupancyPercentages:[]};
   }
   const entry:Entry={aircraftId:a.aircraftId,origin,flightId:review.flightId,reviewedAt:now.toISOString(),decision:'keep_route',
    reviewEvidence:{trigger:review.trigger,reviewedRouteId:a.routeId,selectedRouteId:null,result:'keep_route',routePerformance:[performance]}};
   if(data.entries.some(e=>key(e)===key(entry)))continue;
   if(!validReviewEvidence(entry.reviewEvidence,entry.decision))throw new Error('JOURNAL_ROUTE_REVIEW_INVALID');
   if(data.entries.length>=100000)throw new Error('JOURNAL_FULL: nao descartar historico automaticamente.');
   data.entries.push(entry);added++;
  }
  if(!added)return 0;
  const temporary=join(root,`return-journal.${randomUUID()}.tmp`);
  try{const file=await open(temporary,'wx',0o600);try{await file.writeFile(JSON.stringify(data,null,2)+'\n');await file.sync();}finally{await file.close();}await rename(temporary,filename);}
  catch{throw new Error('JOURNAL_SAVE_FAILED: revisao KEEP nao persistida.');}
  finally{await unlink(temporary).catch(()=>undefined);}
  return added;
 },join(root,'.return-journal.lock'));
}
export async function appendDemandHoldObservations(directory:string,scope:string,runId:string,report:{entries:any[]},now=new Date()):Promise<number>{
 if(!validId(scope)||!validId(runId)||!Number.isFinite(now.getTime()))throw new Error('JOURNAL_CONFIG_INVALID');const root=resolve(directory);await mkdir(root,{recursive:true});return withRunLock(async()=>{const filename=join(root,'return-journal.json');let data:Journal;try{data=validateReturnJournal(JSON.parse(await readFile(filename,'utf8')),scope,now);}catch{throw new Error('JOURNAL_UNAVAILABLE: historico de holds bloqueado.');}const list=data.holdObservations?[...data.holdObservations]:[];let added=0;for(const e of report.entries||[]){if(e?.status!=='held'||e?.demand?.decision!=='hold_insufficient'||!Number.isFinite(e?.demand?.occupancyPercentage))continue;const event:DemandHoldObservation={eventId:`hold_${runId}_${e.aircraftId}_${e.routeId}`,type:'demand-hold',aircraftId:e.aircraftId,routeId:e.routeId,observedAt:now.toISOString(),occupancyPercentage:e.demand.occupancyPercentage,reason:'hold_insufficient'};if(!validHoldObservation(event,now))throw new Error('JOURNAL_HOLD_EVENT_INVALID');if(list.some(x=>x.eventId===event.eventId))continue;list.push(event);added++;}if(!added)return 0;if(list.length>100000)throw new Error('JOURNAL_FULL: nao descartar historico automaticamente.');data.holdObservations=list;const temporary=join(root,`return-journal.${randomUUID()}.tmp`);try{const file=await open(temporary,'wx',0o600);try{await file.writeFile(JSON.stringify(data,null,2)+'\n');await file.sync();}finally{await file.close();}await rename(temporary,filename);}catch{throw new Error('JOURNAL_SAVE_FAILED: historico de holds nao persistido.');}finally{await unlink(temporary).catch(()=>undefined);}return added;},join(root,'.return-journal.lock'));
}
export async function appendSupplyObservation(directory:string,scope:string,runId:string,kind:'fuel'|'co2',snapshot:{pricePer1000:number;holding:number;remainingCapacity:number;balance:number},now=new Date()):Promise<boolean>{
 if(!validId(scope)||!validId(runId)||!Number.isFinite(now.getTime()))throw new Error('JOURNAL_CONFIG_INVALID');const root=resolve(directory);await mkdir(root,{recursive:true});return withRunLock(async()=>{const filename=join(root,'return-journal.json');let data:Journal;try{data=validateReturnJournal(JSON.parse(await readFile(filename,'utf8')),scope,now);}catch{throw new Error('JOURNAL_UNAVAILABLE: historico de suprimentos bloqueado.');}const event:SupplyObservationEvent={eventId:`sup_${runId}_${kind}`,type:'supply-observation',kind,observedAt:now.toISOString(),pricePer1000:snapshot.pricePer1000,holding:snapshot.holding,remainingCapacity:snapshot.remainingCapacity,balance:snapshot.balance};if(!validSupplyObservation(event,now))throw new Error('JOURNAL_SUPPLY_EVENT_INVALID');const list=data.supplyObservations?[...data.supplyObservations]:[];if(list.some(x=>x.eventId===event.eventId))return false;if(list.length>=100000)throw new Error('JOURNAL_FULL: nao descartar historico automaticamente.');list.push(event);data.supplyObservations=list;const temporary=join(root,`return-journal.${randomUUID()}.tmp`);try{const file=await open(temporary,'wx',0o600);try{await file.writeFile(JSON.stringify(data,null,2)+'\n');await file.sync();}finally{await file.close();}await rename(temporary,filename);}catch{throw new Error('JOURNAL_SAVE_FAILED: observacao de suprimento nao persistida.');}finally{await unlink(temporary).catch(()=>undefined);}return true;},join(root,'.return-journal.lock'));
}

export async function appendUncertainSupplyOperation(directory:string,scope:string,runId:string,entry:any,now=new Date()):Promise<boolean>{
 if(!validId(scope)||!validId(runId)||!Number.isFinite(now.getTime())||entry?.status!=='unknown'||typeof entry?.reason!=='string'||!entry.reason.startsWith('OUTCOME_UNKNOWN_NO_RETRY:'))throw new Error('JOURNAL_UNCERTAIN_SUPPLY_INVALID');
 const event:UncertainSupplyEvent={eventId:`sunc_${runId}_${entry.kind}`,type:'supply-uncertain',kind:entry.kind,observedAt:now.toISOString(),result:'outcome_unknown',reason:entry.reason,sourceRunId:runId,pricePer1000:entry.before?.pricePer1000,quantity:entry.plan?.quantity,quotedCost:entry.quotedCost};
 if(!validUncertainSupplyEvent(event,now))throw new Error('JOURNAL_UNCERTAIN_SUPPLY_INVALID');
 const root=resolve(directory);await mkdir(root,{recursive:true});return withRunLock(async()=>{const filename=join(root,'return-journal.json');const data=validateReturnJournal(JSON.parse(await readFile(filename,'utf8')),scope,now);const events=data.events?[...data.events]:[];if(events.some(x=>x.eventId===event.eventId))return false;if(events.length>=100000)throw new Error('JOURNAL_FULL: nao descartar historico automaticamente.');events.push(event);data.events=events;const temporary=join(root,`return-journal.${randomUUID()}.tmp`);try{const file=await open(temporary,'wx',0o600);try{await file.writeFile(JSON.stringify(data,null,2)+'\n');await file.sync();}finally{await file.close();}await rename(temporary,filename);}catch{throw new Error('JOURNAL_SAVE_FAILED: quarentena de suprimento incerto nao persistida.');}finally{await unlink(temporary).catch(()=>undefined);}return true;},join(root,'.return-journal.lock'));
}
export async function appendUncertainPricingMutations(directory:string,scope:string,runId:string,report:{entries:any[]},now=new Date()):Promise<number>{
 if(!validId(scope)||!validId(runId)||!Number.isFinite(now.getTime()))throw new Error('JOURNAL_CONFIG_INVALID');
 const root=resolve(directory);await mkdir(root,{recursive:true});
 return withRunLock(async()=>{
  const filename=join(root,'return-journal.json');const data=validateReturnJournal(JSON.parse(await readFile(filename,'utf8')),scope,now);
  const events=data.events?[...data.events]:[];let added=0;
  for(const e of report.entries||[]){
   if(e?.status!=='outcome_unknown'||e?.reason!=='NO_RETRY_AFTER_PRICE_SAVE_ATTEMPT'||!validCabins(e.before)||!validCabins(e.desired))continue;
   const event:UncertainPricingEvent={eventId:`punc_${runId}_${e.routeId}`,type:'pricing-uncertain',aircraftId:e.aircraftId,registration:e.registration,routeId:e.routeId,
    observedAt:now.toISOString(),result:'outcome_unknown',reason:'NO_RETRY_AFTER_PRICE_SAVE_ATTEMPT',sourceRunId:runId,before:{...e.before},desired:{...e.desired}};
   if(!validUncertainPricingEvent(event,now))throw new Error('JOURNAL_UNCERTAIN_PRICING_INVALID');
   if(events.some(x=>x.eventId===event.eventId))continue;
   if(events.length>=100000)throw new Error('JOURNAL_FULL: nao descartar historico automaticamente.');
   events.push(event);added++;
  }
  if(!added)return 0;data.events=events;
  const temporary=join(root,`return-journal.${randomUUID()}.tmp`);
  try{const file=await open(temporary,'wx',0o600);try{await file.writeFile(JSON.stringify(data,null,2)+'\n');await file.sync();}finally{await file.close();}await rename(temporary,filename);}
  catch{throw new Error('JOURNAL_SAVE_FAILED: quarentena de pricing incerto nao persistida.');}
  finally{await unlink(temporary).catch(()=>undefined);}
  return added;
 },join(root,'.return-journal.lock'));
}

export async function appendUncertainRouteMutations(directory:string,scope:string,runId:string,report:{entries:any[]},now=new Date()):Promise<number>{
 if(!validId(scope)||!validId(runId)||!Number.isFinite(now.getTime()))throw new Error('JOURNAL_CONFIG_INVALID');
 const root=resolve(directory);await mkdir(root,{recursive:true});
 return withRunLock(async()=>{
  const filename=join(root,'return-journal.json');const data=validateReturnJournal(JSON.parse(await readFile(filename,'utf8')),scope,now);
  const events=data.events?[...data.events]:[];let added=0;
  for(const e of report.entries||[]){
   if(e?.status!=='outcome_unknown'||e?.reason!=='NO_RETRY_AFTER_ROUTE_MUTATION_ATTEMPT')continue;
   const event:UncertainRouteEvent={
    eventId:`runc_${runId}_${e.aircraftId}_${e.previousRouteId}_${e.targetAirportId}`,type:'route-uncertain',
    aircraftId:e.aircraftId,registration:e.registration,previousRouteId:e.previousRouteId,previousFrom:e.previousFrom,previousTo:e.previousTo,
    targetFrom:e.targetFrom,targetTo:e.targetTo,targetAirportId:e.targetAirportId,observedAt:now.toISOString(),result:'outcome_unknown',
    reason:'NO_RETRY_AFTER_ROUTE_MUTATION_ATTEMPT',sourceRunId:runId
   };
   if(!validUncertainRouteEvent(event,now))throw new Error('JOURNAL_UNCERTAIN_ROUTE_INVALID');
   if(events.some(x=>x.eventId===event.eventId))continue;
   if(events.length>=100000)throw new Error('JOURNAL_FULL: nao descartar historico automaticamente.');
   events.push(event);added++;
  }
  if(!added)return 0;data.events=events;
  const temporary=join(root,`return-journal.${randomUUID()}.tmp`);
  try{const file=await open(temporary,'wx',0o600);try{await file.writeFile(JSON.stringify(data,null,2)+'\n');await file.sync();}finally{await file.close();}await rename(temporary,filename);}
  catch{throw new Error('JOURNAL_SAVE_FAILED: quarentena de reroute incerto nao persistida.');}
  finally{await unlink(temporary).catch(()=>undefined);}
  return added;
 },join(root,'.return-journal.lock'));
}

export async function appendResolvedUncertainDepartures(directory:string,scope:string,collection:CollectionResult,now=new Date()):Promise<number>{
 if(!validId(scope)||!Number.isFinite(now.getTime())||!collection||!Array.isArray(collection.aircraft))throw new Error('JOURNAL_CONFIG_INVALID');
 if(!collection.complete)return 0;
 const root=resolve(directory);await mkdir(root,{recursive:true});
 return withRunLock(async()=>{
  const filename=join(root,'return-journal.json');const data=validateReturnJournal(JSON.parse(await readFile(filename,'utf8')),scope,now);
  const events=data.events?[...data.events]:[];
  const resolved=new Set(events.filter((e):e is ResolvedUncertainDepartureEvent=>e.type==='departure-uncertain-resolved').map(e=>e.uncertainEventId));
  const counts=new Map<string,number>();for(const a of collection.aircraft)counts.set(a.aircraftId,(counts.get(a.aircraftId)||0)+1);
  let added=0;
  for(const uncertain of events.filter((e):e is UncertainDepartureEvent=>e.type==='departure-uncertain'&&!resolved.has(e.eventId))){
    const matches=collection.aircraft.filter(a=>a.aircraftId===uncertain.aircraftId&&a.routeId===uncertain.routeId);
    if(matches.length!==1||counts.get(uncertain.aircraftId)!==1)continue;
    const a=matches[0],observed=Date.parse(a.observedAt),sourceObserved=Date.parse(uncertain.observedAt);
    const pairMatches=[a.from,a.to].sort().join(':')===[uncertain.from,uncertain.to].sort().join(':');
    const readyVerified=a.state==='ready'&&!a.issue&&!!a.capacity&&!!a.remaining&&!!a.dailyTotal&&typeof a.departureControlShape==='string'&&a.departureControlShape.length>0;
    const inflightVerified=a.state==='inflight'&&!a.issue&&!!a.capacity&&!!a.onboard&&!!a.timing;
    if(a.registration!==uncertain.registration||!pairMatches||!Number.isFinite(observed)||observed<=sourceObserved||observed>now.getTime()||(!readyVerified&&!inflightVerified))continue;
    const event:ResolvedUncertainDepartureEvent={eventId:`res_${uncertain.sourceRunId}_${uncertain.aircraftId}_${uncertain.routeId}`,type:'departure-uncertain-resolved',
      uncertainEventId:uncertain.eventId,aircraftId:uncertain.aircraftId,registration:uncertain.registration,routeId:uncertain.routeId,from:a.from,to:a.to,
      observedAt:a.observedAt,result:'live_state_verified',liveState:a.state as 'ready'|'inflight',reason:'STRICTLY_NEWER_VERIFIED_LIVE_STATE'};
    if(!validResolvedUncertainDepartureEvent(event,now))throw new Error('JOURNAL_UNCERTAIN_DEPARTURE_RESOLUTION_INVALID');
    if(events.some(e=>e.eventId===event.eventId))continue;
    events.push(event);resolved.add(uncertain.eventId);added++;
  }
  if(!added)return 0;if(events.length>100000)throw new Error('JOURNAL_FULL: nao descartar historico automaticamente.');data.events=events;
  const temporary=join(root,`return-journal.${randomUUID()}.tmp`);try{const file=await open(temporary,'wx',0o600);try{await file.writeFile(JSON.stringify(data,null,2)+'\n');await file.sync();}finally{await file.close();}await rename(temporary,filename);}
  catch{throw new Error('JOURNAL_SAVE_FAILED: resolucao de departure incerto nao persistida.');}finally{await unlink(temporary).catch(()=>undefined);}return added;
 },join(root,'.return-journal.lock'));
}

export async function appendUncertainDepartures(directory:string,scope:string,runId:string,report:{entries:any[]},now=new Date()):Promise<number>{if(!validId(scope)||!validId(runId)||!Number.isFinite(now.getTime()))throw new Error('JOURNAL_CONFIG_INVALID');const root=resolve(directory);await mkdir(root,{recursive:true});return withRunLock(async()=>{const filename=join(root,'return-journal.json');const data=validateReturnJournal(JSON.parse(await readFile(filename,'utf8')),scope,now);const events=data.events?[...data.events]:[];let added=0;for(const e of report.entries||[]){if(e?.status!=='outcome_unknown'||typeof e.reason!=='string'||!e.reason.startsWith('NO_RETRY_AFTER_CLICK_ATTEMPT:'))continue;const event:UncertainDepartureEvent={eventId:`unc_${runId}_${e.aircraftId}_${e.routeId}`,type:'departure-uncertain',aircraftId:e.aircraftId,registration:e.registration,routeId:e.routeId,from:e.from,to:e.to,observedAt:now.toISOString(),result:'outcome_unknown',reason:e.reason,sourceRunId:runId};if(!validUncertainDepartureEvent(event,now))throw new Error('JOURNAL_UNCERTAIN_DEPARTURE_INVALID');if(events.some(x=>x.eventId===event.eventId))continue;events.push(event);added++;}if(!added)return 0;data.events=events;const temporary=join(root,`return-journal.${randomUUID()}.tmp`);try{const file=await open(temporary,'wx',0o600);try{await file.writeFile(JSON.stringify(data,null,2)+'\n');await file.sync();}finally{await file.close();}await rename(temporary,filename);}finally{await unlink(temporary).catch(()=>undefined);}return added;},join(root,'.return-journal.lock'));}

/**
 * Closes only the newest confirmed departure for an aircraft when a later,
 * unique live snapshot proves it is ready at that departure's destination and
 * the same route is now reversed. observedAt is the observation time, never an
 * invented landing timestamp. A newer uncertain departure keeps the chain open.
 */
export async function appendObservedArrivals(directory:string,scope:string,collection:CollectionResult,now=new Date()):Promise<number>{
 if(!validId(scope)||!Number.isFinite(now.getTime())||!collection||!Array.isArray(collection.aircraft))throw new Error('JOURNAL_CONFIG_INVALID');
 if(!collection.complete)return 0;
 const root=resolve(directory);await mkdir(root,{recursive:true});
 return withRunLock(async()=>{
  const filename=join(root,'return-journal.json');const data=validateReturnJournal(JSON.parse(await readFile(filename,'utf8')),scope,now);
  const events=data.events?[...data.events]:[];const reconciled=new Set(events.filter((e):e is ArrivalObservationEvent=>e.type==='arrival-observed').map(e=>e.departureEventId));
  const counts=new Map<string,number>();for(const a of collection.aircraft)counts.set(a.aircraftId,(counts.get(a.aircraftId)||0)+1);
  let added=0;
  for(const a of collection.aircraft){
   const observed=Date.parse(a.observedAt);
   if(counts.get(a.aircraftId)!==1||a.state!=='ready'||a.issue||!validId(a.aircraftId)||!validId(a.routeId)||typeof a.registration!=='string'||!a.registration||
      !validOrigin(a.from)||!validOrigin(a.to)||a.from===a.to||!Number.isFinite(observed)||observed>now.getTime())continue;
   const mutations=events.filter((e):e is DepartureHistoryEvent|UncertainDepartureEvent=>(e.type==='departure'||e.type==='departure-uncertain')&&e.aircraftId===a.aircraftId&&Date.parse(e.observedAt)<observed)
     .sort((x,y)=>Date.parse(x.observedAt)-Date.parse(y.observedAt));
   const latest=mutations.at(-1);if(!latest||latest.type!=='departure'||reconciled.has(latest.eventId))continue;
   if(latest.registration!==a.registration||latest.routeId!==a.routeId||a.from!==latest.to||a.to!==latest.from)continue;
   const event:ArrivalObservationEvent={eventId:`arr_${latest.eventId}`,type:'arrival-observed',departureEventId:latest.eventId,aircraftId:latest.aircraftId,registration:latest.registration,
     routeId:latest.routeId,from:latest.from,to:latest.to,departedAt:latest.observedAt,observedAt:a.observedAt,result:'arrived_observed'};
   if(!validArrivalObservationEvent(event,now))throw new Error('JOURNAL_ARRIVAL_EVENT_INVALID');
   if(events.some(e=>e.eventId===event.eventId))continue;
   events.push(event);reconciled.add(latest.eventId);added++;
  }
  if(!added)return 0;if(events.length>100000)throw new Error('JOURNAL_FULL: nao descartar historico automaticamente.');data.events=events;
  const temporary=join(root,`return-journal.${randomUUID()}.tmp`);try{const file=await open(temporary,'wx',0o600);try{await file.writeFile(JSON.stringify(data,null,2)+'\n');await file.sync();}finally{await file.close();}await rename(temporary,filename);}
  catch{throw new Error('JOURNAL_SAVE_FAILED: chegada observada nao persistida.');}finally{await unlink(temporary).catch(()=>undefined);}return added;
 },join(root,'.return-journal.lock'));
}
export async function appendConfirmedDepartures(directory:string,scope:string,runId:string,report:{entries:any[]},now=new Date()):Promise<number>{
  if(!validId(scope)||!validId(runId)||!Number.isFinite(now.getTime()))throw new Error('JOURNAL_CONFIG_INVALID');
  const root=resolve(directory);await mkdir(root,{recursive:true});
  return withRunLock(async()=>{
    const filename=join(root,'return-journal.json');let data:Journal;
    try{data=validateReturnJournal(JSON.parse(await readFile(filename,'utf8')),scope,now);}catch{throw new Error('JOURNAL_UNAVAILABLE: registro invalido/inacessivel; historico de decolagem bloqueado.');}
    const events=data.events?[...data.events]:[];let added=0;
    for(const e of report.entries||[]){
      if(e?.status!=='departed'||e.reason!=='NATIVE_INFLIGHT_IDENTITY_COUNTDOWN_AND_ONBOARD_CONFIRMED'||!e.actualOnboard||!e.demand?.availableBefore||!e.demand?.possiblePassengers||!Number.isFinite(e.demand?.occupancyPercentage))continue;
      const eventId=`dep_${runId}_${e.aircraftId}_${e.routeId}`;
      if(events.some(x=>x.eventId===eventId))continue;
      const event:DepartureHistoryEvent={eventId,type:'departure',aircraftId:e.aircraftId,registration:e.registration,routeId:e.routeId,from:e.from,to:e.to,observedAt:now.toISOString(),result:'departed',
        demand:{availableBefore:{...e.demand.availableBefore},possiblePassengers:{...e.demand.possiblePassengers},occupancyPercentage:e.demand.occupancyPercentage},actualOnboard:{...e.actualOnboard}};
      if(!validDepartureEvent(event,now))throw new Error('JOURNAL_DEPARTURE_EVENT_INVALID');events.push(event);added++;
    }
    if(!added)return 0;if(events.length>100000)throw new Error('JOURNAL_FULL: nao descartar historico automaticamente.');data.events=events;
    const temporary=join(root,`return-journal.${randomUUID()}.tmp`);
    try{const file=await open(temporary,'wx',0o600);try{await file.writeFile(JSON.stringify(data,null,2)+'\n');await file.sync();}finally{await file.close();}await rename(temporary,filename);}
    catch{throw new Error('JOURNAL_SAVE_FAILED: historico de decolagem nao persistido.');}finally{await unlink(temporary).catch(()=>undefined);}
    return added;
  },join(root,'.return-journal.lock'));
}
/** Simulation only. Local lock + atomic replace; never execute a game action inside this transaction. */
export async function reviewWithReturnJournal(input: RouteReview, options: JournalOptions, now = new Date()): Promise<RoutePlan> {
  if (!validId(options.scope) || !validOrigin(options.origin) || !validId(input.position.aircraftId) || !Number.isFinite(now.getTime())) throw new Error('JOURNAL_CONFIG_INVALID');
  if (input.position.homeBase !== options.origin || input.previousPosition && input.previousPosition.homeBase !== options.origin) throw new Error('JOURNAL_ORIGIN_MISMATCH');
  const optimizer = new RouteOptimizer(options.minOccupancy, options.minImprovementPercent, options.maxAgeSeconds);
  const directory = resolve(options.directory);
  await mkdir(directory, { recursive: true });
  return withRunLock(async () => {
    const filename = join(directory, 'return-journal.json');
    let data: Journal;
    try { data = validateReturnJournal(JSON.parse(await readFile(filename, 'utf8')), options.scope, now); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') data = { schemaVersion: 1, scope: options.scope, entries: [] };
      else throw new Error('JOURNAL_UNAVAILABLE: registro invalido/inacessivel; revisao bloqueada.');
    }
    const eventId = reviewEventId(input, now);
    const arrivalKey = eventId ? `${input.position.aircraftId}:${eventId}:${options.origin}` : null;
    if (!arrivalKey) return optimizer.review(input, now);
    if (!validId(eventId)) throw new Error('JOURNAL_FLIGHT_ID_INVALID');
    const entry: Entry = { aircraftId: input.position.aircraftId, origin: options.origin, flightId: eventId!, reviewedAt: now.toISOString(), decision: 'hold' };
    if (data.entries.some(e => key(e) === key(entry))) return { aircraftId: entry.aircraftId, arrivalKey, decision: 'already_reviewed', selectedRouteId: null, scores: [], reason: 'Retorno ja revisado em execucao anterior do mesmo registro.', dryRun: true, mutationAuthorized: false };
    const plan = optimizer.review(input, now);
    if (!completed(plan.decision)) return plan; // Missing data is retryable; never consume the arrival.
    if (data.entries.length >= 100000) throw new Error('JOURNAL_FULL: nao descartar historico automaticamente.');
    data.entries.push({ ...entry, decision: plan.decision, reviewEvidence:{
      trigger:input.trigger==='daily'?'daily':'return',reviewedRouteId:input.currentRouteId,selectedRouteId:plan.selectedRouteId,result:plan.decision,
      routePerformance:plan.scores.map(s=>({routeId:s.routeId,viable:s.viable,netProfit:s.netProfit,netProfitPerHour:s.netProfitPerHour,occupancyPercentages:[...s.occupancyPercentages]}))
    } });
    const temporary = join(directory, `return-journal.${randomUUID()}.tmp`);
    try {
      const file = await open(temporary, 'wx', 0o600);
      try { await file.writeFile(JSON.stringify(data, null, 2) + '\n'); await file.sync(); }
      finally { await file.close(); }
      await rename(temporary, filename);
    } catch { throw new Error('JOURNAL_SAVE_FAILED: resultado da revisao nao liberado.'); }
    finally { await unlink(temporary).catch(() => undefined); }
    return plan;
  }, join(directory, '.return-journal.lock'));
}
