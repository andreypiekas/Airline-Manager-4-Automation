import { Page } from '@playwright/test';
import { DeparturePort } from './executor';
import { AircraftSnapshot, CollectionResult } from './types';
import { DemandReader, collectFleetWithFreshRetry } from './reader';
import { openFleetList,findFleetRoute,reuseCurrentFleetPageForTarget } from './navigation';
import { assertNoInteractiveChallenge } from '../utils/challenge-guard';

/** Complete handler grammar observed in Actions 36917592989/36918147380 on 2026-10-01.
 * Only the native UI is clicked. No manual endpoint calls, parameters or cost-index edits.
 * Constant UI hide selectors/response target are syntactically constrained, not used as our selectors.
 */
export function verifiedDepartureHandler(callback:string,routeId:string):boolean {
  if(!/^[1-9]\d*$/.test(routeId))return false;
  const match=callback.trim().match(/^\$\('([^']+)'\)\.hide\(\);\s*hideFlightInfo\(\);\s*\$\('#routeViewDepart'\)\.hide\(\);\s*Ajax\('route_depart\.php\?id=([1-9]\d*)&ref=list&costIndex=(\d{1,3})','([A-Za-z_][A-Za-z0-9_-]{0,60})',this\);$/);
  return !!match && /^[#.A-Za-z0-9_\s,>-]+$/.test(match[1]) && match[2]===routeId && Number(match[3])<=200;
}
/** The complete, identity-checked Fleet snapshot from this same run can seed dispatch.
 * Every attempted aircraft is freshly read before its native click. This function
 * does not authorize departure and never infers an identity from the route count.
 */
export function validatedDispatchSnapshot(
  snapshot:CollectionResult | undefined,
  currentRouteTotal:number
):CollectionResult|null {
  if(!snapshot?.complete||!Number.isSafeInteger(currentRouteTotal)||currentRouteTotal<1||
    snapshot.expectedRoutes!==currentRouteTotal||snapshot.aircraft.length!==currentRouteTotal)return null;
  const routes=new Set<string>(),aircraft=new Set<string>();
  for(const a of snapshot.aircraft){
    if(!/^[1-9]\d*$/.test(a.routeId)||!/^[1-9]\d*$/.test(a.aircraftId)||
      // Inflight aircraft with failed optional details are skipped, not dispatched.
      // Allow their missing registration only while native IDs and airports remain unique.
      (a.state!=='inflight'&&!a.registration.trim())||!/^[A-Z0-9]{3}$/.test(a.from)||!/^[A-Z0-9]{3}$/.test(a.to)||
      a.from===a.to||routes.has(a.routeId)||aircraft.has(a.aircraftId))return null;
    if(a.state==='ready'&&(!a.capacity||!a.remaining||!a.dailyTotal||a.issue))return null;
    routes.add(a.routeId);aircraft.add(a.aircraftId);
  }
  return {...snapshot,aircraft:snapshot.aircraft.map(a=>({...a})),warnings:[...snapshot.warnings]};
}

export class PlaywrightDeparturePort implements DeparturePort {
  private prepared:{aircraft:AircraftSnapshot;handler:string}|null=null;
  private verifiedRouteCount:number|null=null;
  private readonly metrics={pageReuses:0,fullListNavigations:0,fullFleetScans:0,dispatchCollectMs:0,targetPreparationMs:0};
  navigationMetrics(){return {...this.metrics};}
  constructor(private readonly page:Page,private readonly timeout=15000,
    private readonly collectionRetryDeadlineEpochMs?:number,
    private readonly verifiedEarlierFleet?:CollectionResult){}
  async collect(){
    this.prepared=null;
    const collectStarted=Date.now();
    await assertNoInteractiveChallenge(this.page,'departure:collect');
    await openFleetList(this.page,this.timeout);
    // Read only the freshly rendered Fleet count. The earlier complete inventory
    // already established one-to-one identities; the next attempted aircraft
    // will still get a fresh individual details read and native-control check.
    let currentRouteTotal=-1;
    try{
      const heading=(await this.page.getByRole('button',{name:/^Routes\s*\(\d+\)$/}).innerText({timeout:this.timeout})).trim();
      const match=/^Routes\s*\((\d+)\)$/.exec(heading);
      if(match)currentRouteTotal=Number(match[1]);
    }catch{/* A missing/ambiguous heading triggers a completely fresh scan. */}
    const reused=validatedDispatchSnapshot(this.verifiedEarlierFleet,currentRouteTotal);
    if(reused){
      console.log('[DepartureInventory] '+JSON.stringify({
        status:'VERIFIED_SAME_RUN_SNAPSHOT_REUSED',fleet:reused.aircraft.length,
        ready:reused.aircraft.filter(a=>a.state==='ready').length,
        freshPerTargetValidation:true
      }));
      this.verifiedRouteCount=reused.expectedRoutes;
      this.metrics.dispatchCollectMs=Date.now()-collectStarted;
      return reused;
    }
    if(this.verifiedEarlierFleet)console.warn('[DepartureInventory] '+JSON.stringify({
      status:'FULL_FLEET_RESCAN_REQUIRED',snapshotExpected:this.verifiedEarlierFleet.expectedRoutes,
      currentRouteTotal
    }));
    this.metrics.fullFleetScans++;
    const result=await collectFleetWithFreshRetry(this.page,this.timeout,true,this.collectionRetryDeadlineEpochMs);
    this.verifiedRouteCount=result.complete?result.expectedRoutes:null;
    this.metrics.dispatchCollectMs=Date.now()-collectStarted;
    if(!result.complete){
      // Operational diagnostics only: never log page DOM, URL, session or IDs.
      console.warn('[DepartureCollection] '+JSON.stringify({
        status:'INCOMPLETE',observed:result.aircraft.length,expected:result.expectedRoutes,
        warnings:result.warnings.filter(w=>/^[A-Z0-9_:/.]{1,100}$/.test(w)).slice(0,15)
      }));
    }
    return result;
  }
  async prepare(expected:AircraftSnapshot){
    this.prepared=null;
    const prepareStarted=Date.now();
    await assertNoInteractiveChallenge(this.page,'departure:prepare');
    // Reuse an already-displayed native page whenever the requested route is
    // visible and the live Routes(N) count remains unchanged. Only the target
    // details will authorize its subsequent one-shot departure.
    const samePage=this.verifiedRouteCount!==null &&
      await reuseCurrentFleetPageForTarget(this.page,expected,this.verifiedRouteCount,this.timeout);
    if(samePage)this.metrics.pageReuses++;
    else {
      this.metrics.fullListNavigations++;
      await openFleetList(this.page,this.timeout);
      await findFleetRoute(this.page,expected,this.timeout);
      if(this.verifiedRouteCount!==null){
        const heading=(await this.page.getByRole('button',{name:/^Routes\s*\(\d+\)$/}).innerText({timeout:this.timeout})).trim();
        const count=/^Routes\s*\((\d+)\)$/.exec(heading);
        if(!count||Number(count[1])!==this.verifiedRouteCount)throw new Error('DEPARTURE_FLEET_COUNT_CHANGED');
      }
    }
    const fresh=await new DemandReader(this.page,this.timeout,true).readReadyAircraftDetails(expected);
    const control=this.page.locator('#detailsAction #routeViewDepart');
    const handler=await control.getAttribute('onclick')||'';
    if(await control.count()!==1||!await control.isVisible()||!await control.isEnabled()||!verifiedDepartureHandler(handler,fresh.routeId))throw Error('DEPARTURE_HANDLER_UNVERIFIED');
    this.metrics.targetPreparationMs+=Date.now()-prepareStarted;
    this.prepared={aircraft:fresh,handler};return fresh;
  }
  async depart(expected:AircraftSnapshot){
    const prepared=this.prepared;this.prepared=null; // Consume before any operation, including failures.
    if(!prepared||prepared.aircraft.aircraftId!==expected.aircraftId||prepared.aircraft.routeId!==expected.routeId||
      prepared.aircraft.observedAt!==expected.observedAt||Date.now()-Date.parse(expected.observedAt)>20000)throw Error('DEPARTURE_CONTEXT_EXPIRED');
    const details=this.page.locator('#detailsAction'),control=details.locator('#routeViewDepart');
    if(await details.locator('#ff-name').innerText()!==expected.registration||await control.count()!==1||
      !await control.isVisible()||!await control.isEnabled()||await control.getAttribute('onclick')!==prepared.handler||
      !verifiedDepartureHandler(prepared.handler,expected.routeId))throw Error('DEPARTURE_CONTEXT_CHANGED');
    await assertNoInteractiveChallenge(this.page,'departure:before-click');
    const response=this.page.waitForResponse(r=>{
      try{const u=new URL(r.url());return u.pathname.endsWith('/route_depart.php')&&u.searchParams.get('id')===expected.routeId;}catch{return false;}
    },{timeout:this.timeout});
    const results=await Promise.allSettled([response,control.click({timeout:this.timeout})]);
    if(results[0].status!=='fulfilled'||results[1].status!=='fulfilled'||!results[0].value.ok())throw Error('DEPARTURE_REQUEST_UNCONFIRMED');
  }
  async confirm(expected:AircraftSnapshot){
    // Never retry the departure click. Confirmation re-reads only the targeted
    // aircraft, avoiding a full-fleet scan after every successful departure.
    let last:AircraftSnapshot|null=null;
    for(let attempt=0;attempt<3;attempt++){
      if(attempt>0)await this.page.waitForTimeout(attempt===1?1200:2200);
      try{
        await openFleetList(this.page,this.timeout);
        await findFleetRoute(this.page,expected,this.timeout);
        last=await new DemandReader(this.page,this.timeout,true).readAircraftDetails(expected);
        if(last.state==='inflight')return last;
      }catch{
        // Safe read retry only; no mutation is repeated.
      }
    }
    return last;
  }
}
