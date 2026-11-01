import { Page } from '@playwright/test';
import { DeparturePort, type CurrentRouteFuelEvidence } from './executor';
import { calibrateDemandLabelOnCurrentRoutes } from '../optimization/demand-label-calibration';
import { selectVerifiedRollingFuelTarget,readVerifiedRollingCurrentRouteFuel } from '../optimization/individual-current-route-fuel';
import { loadReference, type AirportCatalog } from '../optimization/reference-data';
import { AircraftSnapshot, CollectionResult } from './types';
import { DemandReader, collectFleetWithFreshRetry } from './reader';
import { openFleetList,findFleetRoute,reuseCurrentFleetPageForTarget } from './navigation';
import { inspectFirstPageReadOnly } from './rolling-first-page';
import { inspectIndividualFirstPage } from './rolling-individual-preflight';
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

/** Log only allowlisted categories for failed post-click, read-only confirmation attempts.
 * Never persist raw Playwright errors: they may contain DOM, URLs or private data.
 * This does not authorize departure or retry a native click.
 */
const SAFE_CONFIRM_READ_FAILURE_CODES=new Set([
  'RESEARCH_LIST_CONTROL_UNVERIFIED','RESEARCH_QUOTE_NOT_CLOSED',
  'RESEARCH_ROUTE_COUNT_UNAVAILABLE','RESEARCH_PAGINATION_INVALID',
  'RESEARCH_ROUTE_NOT_FOUND','RESEARCH_PAGINATION_CONTROL_UNVERIFIED',
  'RESEARCH_PAGINATION_LIMIT','RESEARCH_ROUTE_NOT_AVAILABLE',
  'RESEARCH_IDENTITY_INVALID','RESEARCH_STATE_UNAVAILABLE',
  'RESEARCH_CONTEXT_CHANGED','RESEARCH_NOT_READY','DETAILS_CARD_NOT_VISIBLE',
  'INTERACTIVE_CHALLENGE_DETECTED_STOP','UI_CONTROL_OBSCURED'
]);
export function safeDepartureConfirmReadCode(error:unknown):string {
  const message=error instanceof Error?error.message:'';
  if(SAFE_CONFIRM_READ_FAILURE_CODES.has(message))return message;
  if(/timeout/i.test(message))return 'PLAYWRIGHT_TIMEOUT';
  return 'UNCLASSIFIED';
}

/** Read-only observation of the exact native Fleet control after a departure.
 * AJAX may temporarily hide/recreate its menu; never click an unverified
 * control, infer flight success from this signal, or retry Depart.
 */
export async function waitForVerifiedFleetControlReadOnly(page:Page,maxPolls=6):Promise<boolean>{
  if(!Number.isSafeInteger(maxPolls)||maxPolls<1||maxPolls>8)
    throw Error('DEPARTURE_CONFIRM_FLEET_POLL_INVALID');
  for(let sample=0;sample<maxPolls;sample++){
    const tab=page.locator('#popBtn1'),menu=page.locator('#mapRoutes');
    const tabOpen=await tab.count()===1&&await tab.isVisible();
    const control=tabOpen?tab:menu;
    const callback=tabOpen
      ? "$('.popMenuBtn').removeClass('active');$(this).addClass('active');$('#detailsAction').hide();Ajax('routes.php','routeAction',this,false,false);"
      : "hideAllWhenClick();menuFleet('Routes');";
    if(await control.count()===1&&await control.isVisible()&&
      (await control.getAttribute('onclick')||'').replace(/\s/g,'')===callback.replace(/\s/g,''))
      return true;
    if(sample+1<maxPolls)await page.waitForTimeout(400);
  }
  return false;
}

export class PlaywrightDeparturePort implements DeparturePort {
  private prepared:{aircraft:AircraftSnapshot;handler:string}|null=null;
  private verifiedRouteCount:number|null=null;
  private lastCompleteFleet:CollectionResult|null=null;
  private lastRollingWindow:CollectionResult|null=null;
  private readonly metrics={pageReuses:0,fullListNavigations:0,fullFleetScans:0,dispatchCollectMs:0,targetPreparationMs:0};
  navigationMetrics(){return {...this.metrics};}
  constructor(private readonly page:Page,private readonly timeout=15000,
    private readonly collectionRetryDeadlineEpochMs?:number,
    private readonly verifiedEarlierFleet?:CollectionResult,
    private readonly rollingIndividualMode=false){}
  async collect(){
    this.prepared=null;
    this.lastCompleteFleet=null;
    this.lastRollingWindow=null;
    const collectStarted=Date.now();
    await assertNoInteractiveChallenge(this.page,'departure:collect');
    if(this.rollingIndividualMode){
      const pilot=await inspectIndividualFirstPage(this.page,{
        timeout:Math.min(this.timeout,8000),
        maxCandidates:20,deadlineEpochMs:this.collectionRetryDeadlineEpochMs
      }).catch((error:unknown)=>{
        const message=error instanceof Error?error.message:'';
        if(message==='INTERACTIVE_CHALLENGE_DETECTED_STOP')throw error;
        // Fixed categories only. Playwright exception text can include private
        // DOM, game URLs and session state, so never log the raw exception.
        const code=['RESEARCH_LIST_CONTROL_UNVERIFIED','RESEARCH_QUOTE_NOT_CLOSED',
          'UI_CONTROL_OBSCURED'].includes(message)?message:
          /timeout|waiting for|expect\(/i.test(message)?'UI_WAIT_TIMEOUT':'UNCLASSIFIED';
        console.warn('[RollingDispatchInventory] '+JSON.stringify({
          status:'FIRST_PAGE_READ_ONLY_COLLECTION_FAILED',code,
          globalComplete:false,mutationAuthorized:false,fullFleetScans:0
        }));
        throw Error('ROLLING_FIRST_PAGE_PREFLIGHT_FAILED');
      });
      const shortNoReadyObserved=pilot.window==='SHORT_PAGE' && pilot.readyCandidates===0 &&
        pilot.holds.length===0 && pilot.routeTotal!==null && pilot.routeTotal>0 &&
        pilot.windowObservedAircraft.length>0 &&
        pilot.windowObservedAircraft.every(a=>a.state!=='ready');
      const noReadyVerified=pilot.window==='STABLE' && pilot.readyCandidates===0 &&
        pilot.holds.length===0 && pilot.routeTotal!==null && pilot.routeTotal>0;
      const verifiedWindow=['STABLE','SHORT_PAGE'].includes(pilot.window) &&
        pilot.routeTotal!==null && pilot.routeTotal>0 &&
        pilot.verified>0 && pilot.verifiedAircraft.length===pilot.verified &&
        pilot.verifiedAircraft.every(a=>a.state==='ready'&&!a.issue&&
          !!a.capacity&&!!a.remaining&&!!a.dailyTotal);
      console.log('[RollingDispatchInventory] '+JSON.stringify({
        status:noReadyVerified?'NO_READY_ON_VERIFIED_FIRST_PAGE':verifiedWindow?'INDIVIDUAL_WINDOW_VERIFIED':'HOLD_UNVERIFIED_WINDOW',
        inspected:pilot.inspected,ready:pilot.readyCandidates,verified:pilot.verified,
        heldTargets:pilot.holds.length,
        heading:pilot.routeTotal,globalComplete:false,
        mutationAuthorizedByWindowAlone:false
      }));
      this.metrics.dispatchCollectMs=Date.now()-collectStarted;
      const rolling:CollectionResult={
        aircraft:verifiedWindow?pilot.verifiedAircraft:[],
        complete:false,expectedRoutes:pilot.routeTotal,
        observationScope:(verifiedWindow||noReadyVerified)?'native-individual-first-page' as const:undefined,
        windowNoReadyVerified:noReadyVerified,
        windowShortNoReadyObserved:shortNoReadyObserved,
        windowObservedAircraft:pilot.windowObservedAircraft,
        windowReadyCandidates:pilot.readyCandidates,
        warnings:(verifiedWindow||noReadyVerified)?(pilot.holds.length?['ROLLING_WINDOW_PARTIAL_TARGETS']:[]):['ROLLING_WINDOW_UNVERIFIED']
      };
      this.lastRollingWindow=verifiedWindow?rolling:null;
      return rolling;
    }
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
      this.lastCompleteFleet=reused;
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
    this.lastCompleteFleet=result.complete?result:null;
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
  /** One read-only live quote for an existing route, obtained immediately before
   * the individual prepared departure. Uses the SAME independently verified
   * Fleet snapshot, exact aircraft/route identity, unique airport source ID,
   * native Reroute planner and identity-checked current-route quote. No
   * Create route, Auto Price, maintenance, supplies, Depart or forced clicks.
   * Never extends the quote's permitted age and never authorizes a mutation.
   */
  async readCurrentRouteFuelQuote(expected:AircraftSnapshot):Promise<CurrentRouteFuelEvidence|null>{
    this.prepared=null;
    if(this.rollingIndividualMode){
      const collection=this.lastRollingWindow;
      const target=selectVerifiedRollingFuelTarget(collection,expected);
      if(!target||!collection?.expectedRoutes)return null;
      await assertNoInteractiveChallenge(this.page,'departure:rolling-fuel:catalog');
      let airports:AirportCatalog;
      try{
        airports=await loadReference<AirportCatalog>('airports.json');
        if(!airports.license||!airports.source)return null;
      }catch{return null;}
      return readVerifiedRollingCurrentRouteFuel(
        this.page,target,airports,collection.expectedRoutes,Math.min(this.timeout,10000)
      );
    }
    const inventory=this.lastCompleteFleet;
    if(!inventory?.complete||inventory.expectedRoutes!==inventory.aircraft.length||
       inventory.aircraft.filter(a=>a.aircraftId===expected.aircraftId&&
         a.routeId===expected.routeId&&a.from===expected.from&&a.to===expected.to&&
         a.registration===expected.registration&&a.state==='ready'&&!a.issue).length!==1)
      return null;
    await assertNoInteractiveChallenge(this.page,'departure:fuel-quote:before');
    let airports:AirportCatalog;
    try{
      airports=await loadReference<AirportCatalog>('airports.json');
      if(!airports.license||!airports.source) return null;
    }catch{return null;}
    const report=await calibrateDemandLabelOnCurrentRoutes(
      this.page,inventory,airports,Math.min(this.timeout,10000),1,
      new Set([expected.aircraftId])
    );
    if(!report.uiRestored)throw new Error('DEPARTURE_FUEL_QUOTE_UI_RESTORE_FAILED');
    await assertNoInteractiveChallenge(this.page,'departure:fuel-quote:after');
    const sample=report.samples.length===1?report.samples[0]:null;
    const quote=sample?.currentRouteQuote;
    if(!quote||!sample||sample.aircraftId!==expected.aircraftId||
       sample.routeId!==expected.routeId||sample.registration!==expected.registration||
       sample.from!==expected.from||sample.to!==expected.to||
       quote.aircraftId!==expected.aircraftId||quote.registration!==expected.registration||
       quote.from!==expected.from||quote.to!==expected.to||
       !Number.isSafeInteger(quote.fuelLbs)||quote.fuelLbs<=0)
      return null;
    return {aircraftId:expected.aircraftId,routeId:expected.routeId,
      from:expected.from,to:expected.to,fuelLbs:quote.fuelLbs,observedAt:quote.observedAt};
  }

  async prepare(expected:AircraftSnapshot){
    this.prepared=null;
    const prepareStarted=Date.now();
    await assertNoInteractiveChallenge(this.page,'departure:prepare');
    // Reuse an already-displayed native page whenever the requested route is
    // visible and the live Routes(N) count remains unchanged. Only the target
    // details will authorize its subsequent one-shot departure.
    let fresh:AircraftSnapshot;
    if(this.rollingIndividualMode){
      // The native page is reloaded, rather than replaying a stale offset.
      // An arrival may move the target; that is a HOLD for this aircraft.
      const window=await inspectFirstPageReadOnly(this.page,Math.min(this.timeout,8000));
      if(!['STABLE','SHORT_PAGE'].includes(window.status)||
        window.aircraft.filter(a=>a.aircraftId===expected.aircraftId&&
          a.routeId===expected.routeId&&a.registration===expected.registration&&
          a.state==='ready').length!==1)
        throw Error('ROLLING_TARGET_MOVED_OR_CHANGED');
      fresh=await new DemandReader(this.page,this.timeout,true)
        .readReadyCandidateOnVisiblePage(expected);
      this.metrics.pageReuses++;
    }else{
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
      fresh=await new DemandReader(this.page,this.timeout,true).readReadyAircraftDetails(expected);
    }
    const control=this.page.locator('#detailsAction #routeViewDepart');
    const handler=await control.getAttribute('onclick')||'';
    if(await control.count()!==1||!await control.isVisible()||!await control.isEnabled()||!verifiedDepartureHandler(handler,fresh.routeId))throw Error('DEPARTURE_HANDLER_UNVERIFIED');
    this.metrics.targetPreparationMs+=Date.now()-prepareStarted;
    this.prepared={aircraft:fresh,handler};return fresh;
  }

  /** Strictly read-only reconciliation proof for a PRIOR-RUN uncertain click.
   * Reuses the full fresh first-page target and native Depart control checks
   * from prepare(), but discards the prepared handler and closes details.
   * It NEVER invokes depart() or re-clicks an ambiguous prior departure.
   * Missing restoration evidence is a hard HOLD, not a resolved event. */
  async inspectPersistedUncertainReady(expected:AircraftSnapshot):Promise<AircraftSnapshot>{
    let readyConfirmed=false;
    try{
      const fresh=await this.prepare(expected);
      if(fresh.state!=='ready'||!!fresh.issue||!fresh.departureControlShape)
        throw Error('QUARANTINE_READY_NOT_VERIFIED');
      readyConfirmed=true;
      return fresh;
    }finally{
      this.prepared=null; // revoke all click-ready state unconditionally
      const details=this.page.locator('#detailsAction');
      try{
        if(readyConfirmed&&(await details.count()!==1||!await details.isVisible()))
          throw Error('QUARANTINE_DETAILS_CONTEXT_UNVERIFIED');
        if(await details.count()===1 && await details.isVisible()){
          await assertNoInteractiveChallenge(this.page,'departure:quarantine:before-return');
          const back=this.page.locator('#route-name .glyphicons-chevron-left');
          if(await back.count()!==1||!await back.isVisible())
            throw Error('QUARANTINE_BACK_CONTROL_UNVERIFIED');
          await back.click({timeout:this.timeout});
          await assertNoInteractiveChallenge(this.page,'departure:quarantine:after-return');
          if(await details.isVisible()||!await this.page.locator('#routeAction').isVisible())
            throw Error('QUARANTINE_UI_NOT_RESTORED');
        }
      }catch{
        // No further mutation is ever authorized from this observation.
        throw Error('QUARANTINE_READ_ONLY_UI_RESTORE_FAILED');
      }
    }
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
      if(attempt>0){
        await this.page.waitForTimeout(attempt===1?1200:2200);
        const nativeControlReady=await waitForVerifiedFleetControlReadOnly(this.page);
        console.warn('[DepartureConfirmControl] '+JSON.stringify({
          attempt:attempt+1,nativeControlReady,readOnly:true,mutationAuthorized:false
        }));
      }
      try{
        await openFleetList(this.page,this.timeout);
        await findFleetRoute(this.page,expected,this.timeout);
        last=await new DemandReader(this.page,this.timeout,true).readAircraftDetails(expected);
        if(last.state==='inflight')return last;
      }catch(error){
        // Read-only retry only. Persist a fixed category, never a raw browser error.
        console.warn('[DepartureConfirmRead] '+JSON.stringify({
          attempt:attempt+1,code:safeDepartureConfirmReadCode(error)
        }));
      }
    }
    return last;
  }
}
