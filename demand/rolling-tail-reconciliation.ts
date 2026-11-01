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
export function verifiedPostDispatchShortTail(
  before:CollectionResult,after:CollectionResult,
  confirmedDepartures:ReadonlySet<string>
):boolean{
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
     before.windowObservedAircraft.length!==20||
     after.windowObservedAircraft.length<1||
     after.windowObservedAircraft.length>=20||
     !confirmedDepartures.size)return false;

  const key=(a:{aircraftId:string;routeId:string})=>a.aircraftId+':'+a.routeId;
  const original=new Map<string,(typeof before.windowObservedAircraft)[number]>();
  const routes=new Set<string>();
  for(const a of before.windowObservedAircraft){
    if(!/^[1-9]\d*$/.test(a.aircraftId)||!/^[1-9]\d*$/.test(a.routeId)||
       !a.registration||!['ready','inflight','unavailable'].includes(a.state)||
       original.has(key(a))||routes.has(a.routeId))return false;
    original.set(key(a),a);routes.add(a.routeId);
  }
  // Every originally ready card must have an independently confirmed departure.
  const beforeReady=before.windowObservedAircraft.filter(a=>a.state==='ready');
  if(beforeReady.length===0||beforeReady.length!==before.aircraft.length||
     beforeReady.some(a=>!confirmedDepartures.has(key(a))))return false;
  const observed=new Set<string>();
  const observedRoutes=new Set<string>();
  for(const a of after.windowObservedAircraft){
    const known=original.get(key(a));
    if(!known||a.registration!==known.registration||a.state==='ready'||
       observed.has(key(a))||observedRoutes.has(a.routeId))return false;
    observed.add(key(a));observedRoutes.add(a.routeId);
  }
  const missing=[...original.keys()].filter(k=>!observed.has(k));
  if(missing.length!==20-after.windowObservedAircraft.length||missing.length===0)return false;
  // It is NOT safe to assume a previously inflight/maintenance/unknown card
  // disappeared because of our dispatches; only a confirmed ready target.
  return missing.every(k=>original.get(k)?.state==='ready'&&
    confirmedDepartures.has(k));
}
