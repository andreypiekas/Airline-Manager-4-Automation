import type { AircraftSnapshot, CollectionResult } from './types';
import type { FirstPageObservation } from './rolling-first-page';

const key=(a: Pick<AircraftSnapshot,'aircraftId'|'routeId'>)=>
  a.aircraftId+':'+a.routeId;

/**
 * An observed first page may PRIORITIZE candidates only after a separate,
 * same-run complete and identity-checked Fleet inventory already exists.
 * The page must match the original stable aircraft/route/registration mapping.
 *
 * Never promotes a page window to CollectionResult.complete, and never grants
 * departure permission (individual fresh checks are still required).
 */
export function verifiedFirstPagePriorityKeys(
  collection: CollectionResult | undefined,
  firstPage: FirstPageObservation
): ReadonlySet<string> {
  const empty=()=>new Set<string>();
  if (!collection?.complete||collection.expectedRoutes===null||
      collection.expectedRoutes<1||collection.aircraft.length!==collection.expectedRoutes||
      !['STABLE','SHORT_PAGE'].includes(firstPage.status)||
      firstPage.mutationAuthorized!==false||
      firstPage.routeTotal!==collection.expectedRoutes||
      firstPage.visible!==firstPage.aircraft.length||
      firstPage.ready!==firstPage.aircraft.filter(a=>a.state==='ready').length ||
      firstPage.visible<1 || firstPage.visible>20)
    return empty();

  const aircraftIds=new Map<string,AircraftSnapshot>();
  const routeIds=new Set<string>();
  for(const a of collection.aircraft){
    if (!/^[1-9]\d*$/.test(a.aircraftId)||!/^[1-9]\d*$/.test(a.routeId)||
        !a.registration.trim()||aircraftIds.has(a.aircraftId)||routeIds.has(a.routeId))
      return empty();
    aircraftIds.set(a.aircraftId,a);
    routeIds.add(a.routeId);
  }

  const encountered=new Set<string>(),candidates=new Set<string>();
  for(const observed of firstPage.aircraft){
    const reference=aircraftIds.get(observed.aircraftId);
    if(!reference||reference.routeId!==observed.routeId||
       reference.registration!==observed.registration||
       encountered.has(observed.aircraftId) ||
       // If the aircraft arrived since the global scan, it requires a new
       // independent inventory. A first-page hint never promotes it to ready.
       (observed.state==='ready'&&reference.state!=='ready'))
      return empty();
    encountered.add(observed.aircraftId);
    if(observed.state==='ready')candidates.add(key(reference));
  }
  return candidates;
}

/**
 * Preserve the persistent deferred queue as the strongest scheduling hint.
 * Fresh first-page matches come next, then stable inventory order. No hint
 * authorizes a departure or bypasses the unchanged global/target checks.
 */
export function orderVerifiedDepartureCandidates(
  collection:CollectionResult,
  deferredKeys:ReadonlySet<string>,
  firstPageKeys:ReadonlySet<string>
):AircraftSnapshot[] {
  const ordered=collection.aircraft.filter(a=>a.state!=='inflight');
  if(!collection.complete || (!deferredKeys.size&&!firstPageKeys.size))return ordered;
  const priority=(a:AircraftSnapshot)=>{
    const k=key(a);
    return deferredKeys.has(k)?0:firstPageKeys.has(k)?1:2;
  };
  return ordered.sort((a,b)=>priority(a)-priority(b));
}
