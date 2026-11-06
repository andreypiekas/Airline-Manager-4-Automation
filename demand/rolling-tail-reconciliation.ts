import type { CollectionResult } from './types';

/** Reconcile only an already-verified page-one roster against a shorter,
 * independently double-read, zero-ready native first page.
 *
 * A missing card is acceptable ONLY if its exact aircraft+route was already
 * confirmed airborne in this run. A new card, identity change, previously
 * inflight missing card, unknown departure or absent proof remains unsafe.
 *
 * This is a scoped termination decision, NOT a full-Fleet inventory claim,
 * a departure authorization, or evidence that later native pages are idle.
 */
export type ShortTailRejectionCode =
  'PROVENANCE_UNVERIFIED'|'BASELINE_ROSTER_UNVERIFIED'|
  'BASELINE_READY_UNVERIFIED'|'AFTER_ROSTER_CHANGED'|
  'MISSING_CARDS_NOT_CONFIRMED';

/** Diagnostics never contain aircraft IDs, registrations, game URLs or page HTML. */
export function verifiedPostDispatchShortTail(
  before:CollectionResult,after:CollectionResult,
  confirmedDepartures:ReadonlySet<string>,
  onRejected?:(reason:ShortTailRejectionCode)=>void
):boolean{
  const reject=(reason:ShortTailRejectionCode):false=>{onRejected?.(reason);return false;};
  if(before.complete!==false||after.complete!==false||
     before.observationScope!=='native-individual-first-page'||
     before.warnings.length>0||
     before.expectedRoutes===null||!Number.isSafeInteger(before.expectedRoutes)||
     before.expectedRoutes<=20||
     before.expectedRoutes!==after.expectedRoutes||
     after.windowShortNoReadyObserved!==true||
     after.windowReadyCandidates!==0||
     after.aircraft.length!==0||
     after.warnings.length!==1||
     after.warnings[0]!=='ROLLING_WINDOW_UNVERIFIED'||
     !before.windowObservedAircraft||!after.windowObservedAircraft||
     before.windowObservedAircraft.length<1||
     before.windowObservedAircraft.length>20||
     after.windowObservedAircraft.length<1||
     after.windowObservedAircraft.length>=before.windowObservedAircraft.length||
     !confirmedDepartures.size)return reject('PROVENANCE_UNVERIFIED');

  const key=(a:{aircraftId:string;routeId:string})=>a.aircraftId+':'+a.routeId;
  const original=new Map<string,(typeof before.windowObservedAircraft)[number]>();
  const routes=new Set<string>();
  for(const a of before.windowObservedAircraft){
    if(!/^[1-9]\d*$/.test(a.aircraftId)||!/^[1-9]\d*$/.test(a.routeId)||
       !a.registration||!['ready','inflight','unavailable'].includes(a.state)||
       original.has(key(a))||routes.has(a.routeId))return reject('BASELINE_ROSTER_UNVERIFIED');
    original.set(key(a),a);routes.add(a.routeId);
  }
  // Every originally ready card must have an independently confirmed departure.
  const beforeReady=before.windowObservedAircraft.filter(a=>a.state==='ready');
  if(beforeReady.length===0||beforeReady.length!==before.aircraft.length||
     before.windowReadyCandidates!==beforeReady.length||
     beforeReady.some(a=>!confirmedDepartures.has(key(a)))||
     before.aircraft.some(a=>!beforeReady.some(b=>key(b)===key(a)&&
       b.registration===a.registration&&a.state==='ready'&&!a.issue)))
    return reject('BASELINE_READY_UNVERIFIED');
  const observed=new Set<string>();
  const observedRoutes=new Set<string>();
  for(const a of after.windowObservedAircraft){
    const known=original.get(key(a));
    if(!known||a.registration!==known.registration||a.state==='ready'||
       observed.has(key(a))||observedRoutes.has(a.routeId))
      return reject('AFTER_ROSTER_CHANGED');
    observed.add(key(a));observedRoutes.add(a.routeId);
  }
  const missing=[...original.keys()].filter(k=>!observed.has(k));
  // A previously double-verified short first page is still a valid scoped
  // baseline: compare its exact identities, not an assumed 20-card count.
  // This grants neither first-page completeness nor a new Depart permission.
  if(missing.length!==before.windowObservedAircraft.length-after.windowObservedAircraft.length||
     missing.length===0)return reject('AFTER_ROSTER_CHANGED');
  // It is NOT safe to assume a previously inflight/maintenance/unknown card
  // disappeared because of our dispatches; only a confirmed ready target.
  return missing.every(k=>original.get(k)?.state==='ready'&&
    confirmedDepartures.has(k)) || reject('MISSING_CARDS_NOT_CONFIRMED');
}
