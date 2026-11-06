import type { CollectionResult } from './types';

/** Reconcile only an already-verified page-one roster against an equal-sized
 * or shorter, independently double-read, zero-ready native first page.
 *
 * A formerly READY card may remain visible only when its exact aircraft/route
 * was confirmed airborne in this run and the native card is now INFLIGHT.
 * A missing card is acceptable only for the same confirmed departure.
 * A new, uniquely identified INFLIGHT card may fill the slot vacated by an
 * exactly confirmed departed READY card. This must NEVER hide disappearance
 * of another inflight/unavailable card or any change in an original identity.
 * Unknown departure, unverified new card or absent proof remains unsafe.
 *
 * This is a scoped termination decision, NOT a full-Fleet inventory claim,
 * a departure authorization, or evidence that later native pages are idle.
 */
export type ShortTailRejectionCode =
  'PROVENANCE_UNVERIFIED'|'BASELINE_ROSTER_UNVERIFIED'|
  'BASELINE_READY_UNVERIFIED'|'AFTER_ROSTER_CHANGED'|
  'UNCONFIRMED_OR_INVALID_STATE_CHANGE'|'MISSING_CARDS_NOT_CONFIRMED'|
  'NO_CONFIRMED_ROSTER_CHANGE';

/** Diagnostics never contain aircraft IDs, registrations, game URLs or page HTML. */
export function verifiedPostDispatchShortTail(
  before:CollectionResult,after:CollectionResult,
  confirmedDepartures:ReadonlySet<string>,
  onRejected?:(reason:ShortTailRejectionCode)=>void
):boolean{
  const reject=(reason:ShortTailRejectionCode):false=>{onRejected?.(reason);return false;};
  if(before.complete!==false||after.complete!==false||
     !['native-individual-first-page','native-individual-page'].includes(before.observationScope||'')||
     (before.windowPageIndex??0)!==(after.windowPageIndex??0)||
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
     after.windowObservedAircraft.length>before.windowObservedAircraft.length||
     !confirmedDepartures.size)return reject('PROVENANCE_UNVERIFIED');

  const key=(a:{aircraftId:string;routeId:string})=>a.aircraftId+':'+a.routeId;
  const original=new Map<string,(typeof before.windowObservedAircraft)[number]>();
  const routes=new Set<string>();
  const aircraftIds=new Set<string>();
  const registrations=new Set<string>();
  for(const a of before.windowObservedAircraft){
    if(!/^[1-9]\d*$/.test(a.aircraftId)||!/^[1-9]\d*$/.test(a.routeId)||
       !a.registration||!['ready','inflight','unavailable'].includes(a.state)||
       original.has(key(a))||routes.has(a.routeId)||
       aircraftIds.has(a.aircraftId)||registrations.has(a.registration))
      return reject('BASELINE_ROSTER_UNVERIFIED');
    original.set(key(a),a);routes.add(a.routeId);
    aircraftIds.add(a.aircraftId);registrations.add(a.registration);
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
  const observedAircraftIds=new Set<string>();
  const observedRegistrations=new Set<string>();
  let confirmedNativeInflightTransitions=0;
  let refillCards=0;
  for(const a of after.windowObservedAircraft){
    const known=original.get(key(a));
    // Every new native card needs a unique identity and independent INFLIGHT
    // state proof. Do not accept invented IDs, renamed/rerouted old aircraft,
    // unavailable cards, or new READY aircraft that still need dispatch.
    if(!/^[1-9]\d*$/.test(a.aircraftId)||!/^[1-9]\d*$/.test(a.routeId)||
       !a.registration||a.state==='ready'||
       observed.has(key(a))||observedRoutes.has(a.routeId)||
       observedAircraftIds.has(a.aircraftId)||observedRegistrations.has(a.registration))
      return reject('AFTER_ROSTER_CHANGED');
    if(!known){
      if(a.state!=='inflight'||aircraftIds.has(a.aircraftId)||
         routes.has(a.routeId)||registrations.has(a.registration))
        return reject('AFTER_ROSTER_CHANGED');
      refillCards++;
    }else{
      if(a.registration!==known.registration)
        return reject('AFTER_ROSTER_CHANGED');
      // A departed READY card may remain visible, but must be confirmed
      // INFLIGHT for that same aircraft/route in this exact run.
      if(known.state==='ready'){
        if(a.state!=='inflight'||!confirmedDepartures.has(key(a)))
          return reject('UNCONFIRMED_OR_INVALID_STATE_CHANGE');
        confirmedNativeInflightTransitions++;
      }else if(a.state!==known.state){
        return reject('UNCONFIRMED_OR_INVALID_STATE_CHANGE');
      }
    }
    observed.add(key(a));observedRoutes.add(a.routeId);
    observedAircraftIds.add(a.aircraftId);observedRegistrations.add(a.registration);
  }
  const missing=[...original.keys()].filter(k=>!observed.has(k));
  // A refill slot must be accounted for ONLY by a previously READY,
  // independently confirmed departure. Missing non-READY cards stay unsafe.
  if(missing.length!==before.windowObservedAircraft.length-
       after.windowObservedAircraft.length+refillCards)
    return reject('AFTER_ROSTER_CHANGED');
  if(!missing.every(k=>original.get(k)?.state==='ready'&&confirmedDepartures.has(k)))
    return reject('MISSING_CARDS_NOT_CONFIRMED');
  if(refillCards>missing.length)return reject('AFTER_ROSTER_CHANGED');
  if(missing.length===0&&confirmedNativeInflightTransitions===0)
    return reject('NO_CONFIRMED_ROSTER_CHANGE');
  return true;
}
