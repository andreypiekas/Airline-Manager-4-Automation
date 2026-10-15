import { readOperationalObservation } from '../optimization/observations';
import { automaticFaresFromControl } from '../pricing/ticket-pricing';
import { inspectPricingSaveControl } from '../pricing/control-evidence';
import { expect, Page } from '@playwright/test';
import { AircraftSnapshot, CollectionResult } from './types';
import { CabinText, integerText, parseCapacity, parseDemand, parseOnboard } from './parsing';
import { AIRCRAFT_DETAILS_CONTROL, aircraftIdFromDetailsControl } from './identity';
import { flightCountdownObservation } from '../optimization/flight-timing';
import { departureControlShape } from './departure-control-evidence';
import { readCurrentRouteFieldDiagnostics } from '../optimization/current-route-diagnostics';
import { readFlightHistoryEvidence } from '../optimization/flight-history';
import { routePageLimit, openFleetList, findFleetRoute } from './navigation';
import { GeneralUtils } from '../utils/general.utils';
import { assertNoInteractiveChallenge } from '../utils/challenge-guard';

interface RouteCard {
  routeId: string; aircraftId: string; registration: string; routeLabel: string;
  from: string; to: string; ready: boolean; inflight: boolean; pax: boolean; onboardText: string;
}

function collectionFailureCode(error:unknown):string {
  const message=error instanceof Error?error.message:'';
  if(message==='INTERACTIVE_CHALLENGE_DETECTED_STOP')return message;
  if(message==='PAGINATION_DUPLICATE')return 'PAGINATION_DUPLICATE';
  if(message==='ROUTE_PAGE_LIMIT_INVALID')return 'ROUTE_PAGE_LIMIT_INVALID';
  if(/Timeout|waiting for|expect\(/i.test(message))return 'UI_WAIT_TIMEOUT';
  if(/strict mode violation/i.test(message))return 'AMBIGUOUS_UI_CONTROL';
  return 'UNCLASSIFIED';
}

/** Native AM4 pagination cursor. Never guess the target of an unknown callback. */
function nativeNextStart(callback:string):number|null {
  const match=callback.replace(/\s/g,'').match(/^Ajax\('routes\.php\?start=(\d+)&sort=','routeAction',this\);$/);
  if(!match)return null;
  const value=Number(match[1]);
  return Number.isSafeInteger(value)?value:null;
}

function detailFailureCode(error:unknown):string {
  const message=error instanceof Error?error.message:'';
  if(message==='UI_CONTROL_OBSCURED')return 'UI_CONTROL_OBSCURED';
  if(message==='INTERACTIVE_CHALLENGE_DETECTED_STOP')return 'INTERACTIVE_CHALLENGE_DETECTED_STOP';
  if(message==='Invalid identity')return 'IDENTITY_INVALID';
  if(message==='Ambiguous aircraft link')return 'AIRCRAFT_LINK_AMBIGUOUS';
  if(message==='Unverified details callback')return 'DETAILS_CALLBACK_UNVERIFIED';
  if(message==='DETAILS_CARD_NOT_VISIBLE')return 'DETAILS_CARD_NOT_VISIBLE';
  if(message==='Not ready / grounded')return 'READY_STATE_UNVERIFIED';
  if(message==='Inflight identity not confirmed')return 'INFLIGHT_IDENTITY_UNVERIFIED';
  if(message==='Registration mismatch')return 'REGISTRATION_MISMATCH';
  if(message==='Route mismatch')return 'ROUTE_MISMATCH';
  if(message==='Inflight direction mismatch')return 'INFLIGHT_DIRECTION_MISMATCH';
  if(/Cabin container ambiguous/i.test(message))return 'CABIN_CONTAINER_AMBIGUOUS';
  if(/Missing\/ambiguous cabin/i.test(message))return 'CABIN_ICON_AMBIGUOUS';
  if(/Demand format ambiguous|Esperada demanda/i.test(message))return 'DEMAND_FORMAT_UNVERIFIED';
  if(/Numero ausente|Numero fora/i.test(message))return 'CABIN_NUMBER_UNVERIFIED';
  if(/Demanda restante/i.test(message))return 'DEMAND_REMAINING_EXCEEDS_TOTAL';
  if(/Timeout|waiting for|expect\(/i.test(message))return 'DETAILS_UI_TIMEOUT';
  return 'DETAILS_UNCLASSIFIED';
}
/** Read-only navigation using DOM inspected on 2026-09-29. No direct HTTP requests. */
export class DemandReader {
  constructor(private readonly page: Page, private readonly timeout = 10000, private readonly includeInflightDetails = false) {}

  async collect(): Promise<CollectionResult> {
    const result: CollectionResult = { aircraft: [], complete: false, expectedRoutes: null, warnings: [] };
    const seenRoutes = new Set<string>();
    const verifiedPages: string[][] = [];
    const pendingDetails: Array<{card: RouteCard; item: AircraftSnapshot}> = [];
    const nativePageSize=20;
    let firstWindowShort=false;
    const pageDiagnostics=async(index:number,expected:number)=>{
      const ids=await visibleRouteIds().catch(()=>[] as string[]);
      const rendered=await this.page.locator('#routesContainer [id^="routeMainList"]').evaluateAll(es=>({
        totalNodes:es.length,hiddenNodes:es.filter(e=>!e.getClientRects().length).length,
        cargoNodes:es.filter(e=>!e.classList.contains('classPAX')).length,
        duplicateIds:es.length-new Set(es.map(e=>e.id)).size
      })).catch(()=>({totalNodes:0,hiddenNodes:0,cargoNodes:0,duplicateIds:0}));
      const next=this.page.locator('#routesContainer .pagination').getByRole('link',{name:'Next',exact:true});
      const cursor=await next.count()===1?nativeNextStart(await next.getAttribute('onclick')||''):null;
      return {
        page:index,expected,visible:ids.length,unique:new Set(ids).size,
        overlap:ids.filter(id=>seenRoutes.has(id)).length,nextStart:cursor,
        total:result.expectedRoutes,...rendered
      };
    };
    const visibleRouteIds=async()=>this.page.locator('#routesContainer [id^="routeMainList"]').evaluateAll(es=>
      es.filter(e=>!!e.getClientRects().length).map(e=>e.id.replace(/^routeMainList/,'')));
    const freshPage=async(required:number)=>{
      const ids=await visibleRouteIds();
      return ids.length===required&&new Set(ids).size===ids.length&&
        ids.every(id=>/^\d+$/.test(id)&&!seenRoutes.has(id));
    };
    const restorePage=async(index:number,required:number,total:number)=>{
      // Never reuse a partial page. Start from the inspected Fleet control and
      // verify the exact previously observed identities of all preceding pages.
      for(let attempt=1;attempt<=2;attempt++){
        try{
          await openFleetList(this.page,this.timeout);
          const heading=await this.page.getByRole('button',{name:/^Routes\s*\(\d+\)$/}).innerText({timeout:this.timeout});
          if(integerText(heading.match(/\((\d+)\)/)![1])!==total)return false;
          for(let cursor=0;cursor<=index;cursor++){
            if(cursor<index){
              const expected=verifiedPages[cursor];
              await expect.poll(async()=>JSON.stringify(await visibleRouteIds()),{timeout:this.timeout})
                .toBe(JSON.stringify(expected));
              const next=this.page.locator('#routesContainer .pagination')
                .getByRole('link',{name:'Next',exact:true});
              if(await next.count()!==1||!await next.isVisible()||
                nativeNextStart(await next.getAttribute('onclick')||'')!==(cursor+1)*20)
                throw Error('FLEET_PAGE_REPLAY_CONTROL_UNVERIFIED');
              const firstId=expected[0];
              await next.click({timeout:this.timeout});
              await expect.poll(async()=> (await visibleRouteIds())[0]||null,{timeout:this.timeout})
                .not.toBe(firstId);
            }else{
              await expect.poll(()=>freshPage(required),{timeout:this.timeout}).toBe(true);
            }
          }
          console.log('[FleetPagination] '+JSON.stringify({page:index,recoveryAttempt:attempt,verifiedPages:index,remaining:required}));
          return true;
        }catch(error){
          if(collectionFailureCode(error)==='INTERACTIVE_CHALLENGE_DETECTED_STOP')throw error;
        }
      }
      return false;
    };
    let stage='FLEET_OPEN';
    try {
      await this.page.locator('#routesContainer').waitFor({ state: 'visible', timeout: this.timeout });
      stage='ROUTE_COUNT';
      const heading = await this.page.getByRole('button', { name: /^Routes\s*\(\d+\)$/ }).innerText();
      result.expectedRoutes = integerText(heading.match(/\((\d+)\)/)![1]);
      let maxPages=1,firstPageSize=0;
      for (let pageIndex = 0; pageIndex < maxPages; pageIndex++) {
        stage='PAGE_ROWS';
        const rows = this.page.locator('#routesContainer [id^="routeMainList"]');
        if (result.expectedRoutes > 0) await rows.first().waitFor({ state: 'visible', timeout: this.timeout });
        if(pageIndex===0 && result.expectedRoutes>nativePageSize){
          const initialNext=this.page.locator('#routesContainer .pagination').getByRole('link',{name:'Next',exact:true});
          const isNativeFirst=await initialNext.count()===1 &&
            nativeNextStart(await initialNext.getAttribute('onclick')||'')===nativePageSize;
          if(isNativeFirst){
            // A native start=20 callback verifies the page *offset*, not that
            // exactly 20 route cards were rendered. A persistently short
            // window must never define the page size. A read-only inventory
            // may traverse all native offsets, but NO mutation is authorized
            // until the final 1:1 aircraft/route inventory is reconciled.
            try{
              await expect.poll(async()=>{
                const ids=await visibleRouteIds();
                return ids.length===nativePageSize && new Set(ids).size===nativePageSize &&
                  ids.every(id=>/^\d+$/.test(id));
              },{timeout:this.timeout}).toBe(true);
            }catch{
              const ids=await visibleRouteIds();
              firstWindowShort=ids.length<nativePageSize;
              console.warn('[FleetPageDiagnostic] '+JSON.stringify({
                ...await pageDiagnostics(0,nativePageSize),
                status:'INITIAL_NATIVE_WINDOW_SHORT_READ_ONLY_CONTINUE'
              }));
              if(!firstWindowShort || !ids.length || new Set(ids).size!==ids.length ||
                 !ids.every(id=>/^[1-9]\d*$/.test(id))){
                result.warnings.push('PAGINATION_INITIAL_PAGE_INCOMPLETE');
                return result;
              }
            }
          }
        }
        if(pageIndex>0){
          stage='PAGINATION_PAGE_VERIFY';
          const required=Math.min(firstPageSize,result.expectedRoutes-seenRoutes.size);
          try{
            await expect.poll(()=>freshPage(required),{timeout:this.timeout}).toBe(true);
          }catch{
            console.warn('[FleetPageDiagnostic] '+JSON.stringify(await pageDiagnostics(pageIndex,required)));
            stage='PAGINATION_PAGE_RECOVERY';
            if(!await restorePage(pageIndex,required,result.expectedRoutes)){
              console.warn('[FleetPageDiagnostic] '+JSON.stringify(await pageDiagnostics(pageIndex,required)));
              result.warnings.push('PAGINATION_OVERLAP_OR_INCOMPLETE','PAGINATION_PAGE:'+pageIndex);
              if(firstWindowShort)result.warnings.push('PAGINATION_INITIAL_PAGE_INCOMPLETE');
              throw Error('PAGINATION_DUPLICATE');
            }
          }
        }
        const cards: RouteCard[] = await rows.evaluateAll((elements, pattern) => elements.filter(el => !!el.getClientRects().length).map(el => {
          const routeId = el.id.replace(/^routeMainList/, '');
          const links = Array.from(el.querySelectorAll('a')).map(link => ({link,
            id:(link.getAttribute('onclick')||'').replace(/\s/g,'').match(new RegExp(pattern))?.[1]})).filter(a=>a.id);
          const registration = links.length === 1 ? links[0].link.querySelector('[id^="acRegList"]') : null;
          const aircraftId = links.length === 1 && (!registration || registration.id === `acRegList${links[0].id}`) ? links[0].id! : '';
          const routeLabel = Array.from(el.querySelectorAll('span.s-text')).map(e => e.textContent?.trim() || '').find(t => /^[A-Z0-9]{3}\s*-\s*[A-Z0-9]{3}$/.test(t)) || '';
          const codes = routeLabel.split(/\s*-\s*/);
          const depart = el.querySelector<HTMLButtonElement>(`#listDepart${routeId}`);
          const visible = !!el.getClientRects().length;
          return { routeId, aircraftId, registration: registration?.textContent?.trim() || '', routeLabel,
            from: codes[0] || '', to: codes[1] || '', pax: el.classList.contains('classPAX'),
            ready: visible && el.classList.contains('listDepartable') && !!depart && !depart.disabled && !!depart.getClientRects().length,
            onboardText: ((el as HTMLElement).innerText.match(/Onboard:[^\n]*/) || [''])[0].trim(),
            inflight: visible && /Onboard\s*:/.test((el as HTMLElement).innerText) };
        }), AIRCRAFT_DETAILS_CONTROL);
        if(pageIndex===0){
          const nativeNext=this.page.locator('#routesContainer .pagination').getByRole('link',{name:'Next',exact:true});
          const usesNative20=result.expectedRoutes>nativePageSize &&
            await nativeNext.count()===1 && nativeNextStart(await nativeNext.getAttribute('onclick')||'')===nativePageSize;
          firstPageSize=usesNative20?nativePageSize:cards.length;
          maxPages=routePageLimit(result.expectedRoutes,Math.max(1,firstPageSize));
        }
        verifiedPages.push(cards.map(card=>card.routeId));
        // Phase 1: capture the entire Fleet inventory before opening any
        // aircraft detail. Detail/back AJAX callbacks can reorder or reset
        // Fleet pagination and invalidate offsets while scanning pages.
        for (const card of cards) {
          if (seenRoutes.has(card.routeId)) throw new Error('PAGINATION_DUPLICATE');
          seenRoutes.add(card.routeId);
          const item: AircraftSnapshot = { aircraftId: card.aircraftId, routeId: card.routeId, registration: card.registration,
            routeLabel: card.routeLabel, from: card.from, to: card.to, state: card.inflight ? 'inflight' : 'unavailable',
            capacity: null, onboard: card.inflight ? parseOnboard(card.onboardText) : null, remaining: null, dailyTotal: null, observedAt: new Date().toISOString() };
          result.aircraft.push(item);
          if (!card.pax) {
            item.issue = 'Carga/charter nao suportado nesta versao.';
          } else if(card.ready || (this.includeInflightDetails && card.inflight)){
            pendingDetails.push({card,item});
          }
        }
        if(seenRoutes.size===result.expectedRoutes){
          // Phase 2: inspect details only after the whole route inventory is
          // verified. Re-open native Fleet only if the target row is absent.
          stage='AIRCRAFT_DETAILS';
          console.log('[FleetInventory] '+JSON.stringify({
            status:'COMPLETE_BEFORE_DETAILS',observed:seenRoutes.size,expected:result.expectedRoutes,
            detailCandidates:pendingDetails.length
          }));
          // Start from the current last page; this avoids immediately
          // resetting a valid cursor before reading its own aircraft.
          for(const {card,item} of [...pendingDetails].reverse()){
            try{
              const target=this.page.locator('#routeMainList'+card.routeId);
              if(await target.count()!==1 || !(await target.isVisible())){
                await openFleetList(this.page,this.timeout);
                await findFleetRoute(this.page,item,this.timeout);
              }
              await this.readDetails(card,item);
            }catch(error){
              const reason=detailFailureCode(error);
              if(reason==='INTERACTIVE_CHALLENGE_DETECTED_STOP')throw error;
              item.state=card.inflight?'inflight':'unavailable';
              item.issue='Falha de carregamento, identidade ou leitura dos detalhes.';
              const route=/^\d+$/.test(card.routeId)?card.routeId:'invalid-id';
              result.warnings.push('DETAILS_UNAVAILABLE:'+route,'DETAILS_REASON:'+route+':'+reason);
            }finally{
              const back=this.page.locator('#route-name .glyphicons-chevron-left');
              if(await back.isVisible())await back.click({timeout:this.timeout});
              await this.page.locator('#routeAction').waitFor({state:'visible',timeout:this.timeout});
            }
          }
          if(firstWindowShort){
            const validRouteIds=result.aircraft.every(a=>/^[1-9]\\d*$/.test(a.routeId));
            const validAircraftIds=result.aircraft.every(a=>/^[1-9]\\d*$/.test(a.aircraftId)) &&
              new Set(result.aircraft.map(a=>a.aircraftId)).size===result.expectedRoutes;
            if(!validRouteIds||!validAircraftIds){
              result.warnings.push('FLEET_SHORT_WINDOW_IDENTITY_UNVERIFIED');
              return result;
            }
            console.warn('[FleetPageDiagnostic] '+JSON.stringify({
              status:'SHORT_WINDOW_RECONCILED',observed:seenRoutes.size,expected:result.expectedRoutes
            }));
          }
          result.complete=true;
          return result;
        }
        stage='PAGINATION_NEXT';
        const next = this.page.locator('#routesContainer .pagination').getByRole('link', { name: 'Next', exact: true });
        if (pageIndex===maxPages-1 || await next.count()!==1) {
          result.warnings.push('ROUTE_COUNT_MISMATCH','ROUTE_COUNT:'+seenRoutes.size+'/'+result.expectedRoutes);
          return result;
        }
        const firstId = cards[0]?.routeId;
        if (!firstId) {
          result.warnings.push('PAGINATION_ID_UNVERIFIED');
          return result;
        }
        // Opening/closing aircraft details can reset the Fleet pagination
        // cursor. Verify the *entire* current page and the native Next target,
        // not merely that the first route changed after a click.
        const samePage=async()=>{
          const visibleIds=await rows.evaluateAll(es=>es.filter(e=>!!e.getClientRects().length).map(e=>e.id.replace(/^routeMainList/,'')));
          return visibleIds.length===cards.length&&visibleIds.every((id,i)=>id===cards[i].routeId);
        };
        const targetStart=(pageIndex+1)*20;
        const readNextStart=async()=>nativeNextStart(await next.getAttribute('onclick')||'');
        const nativeCursor=await readNextStart();
        if(!await samePage()||(nativeCursor!==null&&nativeCursor!==targetStart)){
          stage='PAGINATION_CONTEXT_RESTORE';
          try{
            // Read-only reset through the inspected Fleet tab. Walk forward
            // using exact native offsets, then cross-check page identities.
            await openFleetList(this.page,this.timeout);
            for(let cursor=0;cursor<pageIndex;cursor++){
              const link=this.page.locator('#routesContainer .pagination').getByRole('link',{name:'Next',exact:true});
              if(await link.count()!==1||nativeNextStart(await link.getAttribute('onclick')||'')!==(cursor+1)*20)
                throw Error('FLEET_CURSOR_UNVERIFIED');
              const oldId=await rows.evaluateAll(es=>es.find(e=>!!e.getClientRects().length)?.id||null);
              await link.click({timeout:this.timeout});
              await expect.poll(()=>rows.evaluateAll(es=>es.find(e=>!!e.getClientRects().length)?.id||null),
                {timeout:this.timeout}).not.toBe(oldId);
            }
          }catch(error){
            if(collectionFailureCode(error)==='INTERACTIVE_CHALLENGE_DETECTED_STOP')throw error;
            result.warnings.push('PAGINATION_CONTEXT_RESTORE_FAILED');
            return result;
          }
          if(!await samePage()||await readNextStart()!==targetStart){
            result.warnings.push('PAGINATION_CONTEXT_NOT_RESTORED');
            return result;
          }
        }
        stage='PAGINATION_NEXT';
        // Retry a stalled read-only pagination control only once. A partial
        // collection never authorizes any departure, reroute, or pricing.
        let advanced=false;
        for(let attempt=1;attempt<=2;attempt++){
          const currentId=await rows.evaluateAll(es=>es.find(e=>!!e.getClientRects().length)?.id||null);
          if(currentId!=='routeMainList'+firstId){advanced=true;break;}
          if(await next.count()!==1||!await next.isVisible())break;
          try{
            await next.click({timeout:this.timeout});
            await expect.poll(async()=>rows.evaluateAll(es=>es.find(e=>!!e.getClientRects().length)?.id||null),
              {timeout:this.timeout}).not.toBe('routeMainList'+firstId);
            advanced=true;
            break;
          }catch(error){
            if(collectionFailureCode(error)==='INTERACTIVE_CHALLENGE_DETECTED_STOP')throw error;
            const afterClick=await rows.evaluateAll(es=>es.find(e=>!!e.getClientRects().length)?.id||null).catch(()=>null);
            if(afterClick&&afterClick!=='routeMainList'+firstId){advanced=true;break;}
          }
        }
        if(!advanced){
          result.warnings.push('PAGINATION_STALLED','ROUTE_COUNT:'+seenRoutes.size+'/'+result.expectedRoutes);
          return result;
        }
      }
      result.warnings.push('PAGINATION_LIMIT','ROUTE_COUNT:'+seenRoutes.size+'/'+result.expectedRoutes);
      if(firstWindowShort)result.warnings.push('PAGINATION_INITIAL_PAGE_INCOMPLETE');
    } catch(error) {
      if(collectionFailureCode(error)==='INTERACTIVE_CHALLENGE_DETECTED_STOP')throw error;
      result.warnings.push('COLLECTION_FAILED','COLLECTION_STAGE:'+stage,
        'COLLECTION_REASON:'+collectionFailureCode(error),
        'ROUTE_COUNT:'+seenRoutes.size+'/'+(result.expectedRoutes??'unknown'));
    }
    return result;
  }

  /** Re-read one known aircraft from the currently visible route page.
   * Used for fresh pre-departure evidence and targeted post-click confirmation.
   */
  async readAircraftDetails(expected: AircraftSnapshot): Promise<AircraftSnapshot> {
    if (!/^[1-9]\d*$/.test(expected.aircraftId) || !/^[1-9]\d*$/.test(expected.routeId)) throw new Error('RESEARCH_IDENTITY_INVALID');
    const row = this.page.locator(`#routeMainList${expected.routeId}`);
    if (await row.count() !== 1 || !await row.isVisible() || !await row.evaluate(e => e.classList.contains('classPAX'))) throw new Error('RESEARCH_ROUTE_NOT_AVAILABLE');
    const callbacks=await row.locator('a').evaluateAll(es=>es.map(e=>e.getAttribute('onclick')||''));
    if(callbacks.filter(callback=>aircraftIdFromDetailsControl(callback)===expected.aircraftId).length!==1)throw new Error('RESEARCH_IDENTITY_INVALID');
    const routeLabel=expected.routeLabel;
    const depart=row.locator(`#listDepart${expected.routeId}`);
    const ready=await row.evaluate(e=>e.classList.contains('listDepartable'))&&await depart.count()===1&&await depart.isVisible()&&await depart.isEnabled();
    const rowText=await row.innerText();
    const inflight=/Onboard\s*:/.test(rowText);
    if((ready&&inflight)||(!ready&&!inflight))throw new Error('RESEARCH_STATE_UNAVAILABLE');
    const onboardText=(rowText.match(/Onboard:[^\n]*/)||[''])[0].trim();
    const item: AircraftSnapshot = { ...expected, routeLabel, capacity: null, remaining: null, dailyTotal: null, operational: null, fares: undefined,
      onboard: inflight?parseOnboard(onboardText):null,state: inflight?'inflight':'unavailable' };
    const card: RouteCard = { routeId:expected.routeId,aircraftId:expected.aircraftId,registration:expected.registration,routeLabel,
      from:expected.from,to:expected.to,ready,inflight,pax:true,onboardText };
    await this.readDetails(card, item);
    if (item.issue || item.registration!==expected.registration || item.from !== expected.from || item.to !== expected.to || !item.capacity || !expected.capacity ||
      ['Y','J','F'].some(k => item.capacity![k as keyof typeof item.capacity] !== expected.capacity![k as keyof typeof expected.capacity])) throw new Error('RESEARCH_CONTEXT_CHANGED');
    return item;
  }

  /** Re-read a ready aircraft on the currently visible route page before research. */
  async readReadyAircraftDetails(expected: AircraftSnapshot): Promise<AircraftSnapshot> {
    const item=await this.readAircraftDetails(expected);
    if(item.state!=='ready')throw new Error('RESEARCH_NOT_READY');
    return item;
  }

  private async readDetails(card: RouteCard, item: AircraftSnapshot): Promise<void> {
    if (!/^\d+$/.test(card.routeId) || !/^\d+$/.test(card.aircraftId)) throw new Error('Invalid identity');
    const cardLocator = this.page.locator(`#routeMainList${card.routeId}`);
    if (await cardLocator.count() !== 1 || !(await cardLocator.isVisible())) throw new Error('DETAILS_CARD_NOT_VISIBLE');
    const links = cardLocator.locator('a');
    const callbacks = await links.evaluateAll(es=>es.map(e=>e.getAttribute('onclick')||''));
    const matching = callbacks.map((callback,index)=>({index,id:aircraftIdFromDetailsControl(callback)})).filter(a=>a.id===card.aircraftId);
    if (matching.length !== 1) throw new Error('Ambiguous aircraft link');
    const link = links.nth(matching[0].index);
    const callback = (await link.getAttribute('onclick') || '').replace(/\s/g, '');
    const expected = `playSound('neutral_click');Ajax('fleet_details.php?id=${card.aircraftId}','detailsAction');if(intro==0){$('#routeAction').hide();}`;
    if (callback !== expected) throw new Error('Unverified details callback');
    await GeneralUtils.moveAndClick(this.page, link, this.timeout);
    const details = this.page.locator('#detailsAction');
    await details.waitFor({ state: 'visible', timeout: this.timeout });
    const depart = details.locator('#routeViewDepart');
    if (card.ready) {
      await depart.waitFor({ state: 'visible', timeout: this.timeout });
      await expect(depart).toHaveAttribute('onclick', new RegExp(`route_depart\\.php\\?id=${card.routeId}&`), { timeout: this.timeout });
      if (!(await depart.isEnabled()) || !(await details.locator('#routeViewGround_unground').isVisible())) throw new Error('Not ready / grounded');
      item.departureControlShape = departureControlShape(await depart.getAttribute('onclick') || '');
    } else {
      // Inspected on the ATR in flight: countdown plus independent aircraft/route identities.
      await details.locator('#timer').waitFor({ state: 'visible', timeout: this.timeout });
      const callbacks = await details.locator('button').evaluateAll(es => es.map(e => e.getAttribute('onclick') || ''));
      if (!callbacks.some(s => s.includes(`fleet_details.php?id=${card.aircraftId}&mode=reg&`)) ||
          !callbacks.some(s => s.includes(`fleet_details.php?id=${card.routeId}&mode=routeReg&`)) || await depart.isVisible()) throw new Error('Inflight identity not confirmed');
    }
    const observedRegistration = (await details.locator('#ff-name').innerText({timeout:this.timeout})).trim();
    if (!observedRegistration || (card.registration && observedRegistration !== card.registration) ||
      !(await link.innerText()).trim().startsWith(`${observedRegistration} - `)) throw new Error('Registration mismatch');
    if (!(await details.locator('#seat-layout').isVisible())) await details.getByText('Seat layout', { exact: true }).click({ timeout: this.timeout });
    if (!(await details.locator('#list-demand').isVisible())) await details.getByText('Todays demand', { exact: true }).click({ timeout: this.timeout });
    await details.locator('#seat-layout').waitFor({ state: 'visible', timeout: this.timeout });
    const text = await details.evaluate(el => {
      const readCabins = (selector: string, capacity: boolean) => {
        const out = { Y: '', J: '', F: '' };
        const root = Array.from(el.querySelectorAll(selector))
          .filter(node => !!(node as HTMLElement).getClientRects().length);
        if (root.length !== 1) throw new Error('Cabin container ambiguous');
        for (const [key, file] of [['Y', 'economy_seat.png'], ['J', 'business_seat.png'], ['F', 'first_seat.png']] as const) {
          const images = Array.from(root[0].querySelectorAll('img')).filter(img => {
            const src=(img.getAttribute('src')||'').split('?')[0].split('#')[0];
            return src.endsWith('/'+file) || src===file || src.endsWith(file);
          });
          if (images.length !== 1) throw new Error('Missing/ambiguous cabin');
          const cell = images[0].parentElement as HTMLElement | null;
          if (!cell) throw new Error('Missing/ambiguous cabin');
          const raw = cell.innerText.replace(/\s+/g,' ').trim();
          if (capacity) {
            const candidates = Array.from(cell.childNodes)
              .filter(n => n.nodeType === Node.TEXT_NODE)
              .map(n => (n.textContent||'').trim())
              .filter(Boolean);
            const direct = candidates.find(v => /^\d[\d,]*$/.test(v));
            const fallback = raw.match(/(?:^|\s)(\d[\d,]*)(?:\s|$)/)?.[1] || '';
            out[key] = direct || fallback;
          } else {
            const matches=[...raw.matchAll(/(\d[\d,]*)\s*\/\s*(\d[\d,]*)/g)];
            if(matches.length!==1) throw new Error('Demand format ambiguous');
            out[key]=matches[0][1]+'/'+matches[0][2];
          }
        }
        return out;
      };
      const codes = Array.from(el.querySelectorAll('.col-5 span.l-text')).map(e => e.textContent?.trim() || '');
      return { seats: readCabins('#seat-layout', true), demand: readCabins('#list-demand', false), codes };
    });
    if (text.codes.length !== 2 || [...text.codes].sort().join(':') !== [card.from, card.to].sort().join(':')) throw new Error('Route mismatch');
    const capacity = parseCapacity(text.seats as CabinText);
    const demand = parseDemand(text.demand as CabinText);
    if (card.inflight && (text.codes[0] !== card.from || text.codes[1] !== card.to)) throw new Error('Inflight direction mismatch');
    Object.assign(item, { registration:observedRegistration, capacity, ...demand, from: text.codes[0], to: text.codes[1], state: card.inflight ? 'inflight' : 'ready', observedAt: new Date().toISOString() });
    item.demandResetHints=(await details.locator('#list-demand').innerText()).split(/\r?\n/)
      .map(s=>s.trim()).filter(s=>/\b(?:reset|renewal|renews?|renewed|refill|replenishment)\b/i.test(s)).slice(0,10).map(s=>s.slice(0,200));
    item.operational = await readOperationalObservation(details);
    item.currentRouteFieldDiagnostics = await readCurrentRouteFieldDiagnostics(details);
    item.flightHistory = await readFlightHistoryEvidence(details);
    // Countdown was inspected in flight. Zero/malformed values never confirm landing or departure.
    item.timing = card.inflight && await details.locator('#timer').count()===1 ?
      flightCountdownObservation(item.aircraftId,item.routeId,await details.locator('#timer').innerText(),new Date().toISOString()) : null;
    // Read only the inspected Auto callback and ticket inputs. Never click Auto/Save or fill inputs.
    try {
      const auto = details.locator('#seat-layout').getByRole('button', { name: 'Auto', exact: true });
      if (await auto.count() !== 1 || !(await auto.isVisible())) throw new Error('Auto unavailable');
      const automatic = automaticFaresFromControl(await auto.getAttribute('onclick') || '');
      let current = null;
      try {
        current = { Y: integerText(await details.locator('#eTicket').inputValue()), J: integerText(await details.locator('#bTicket').inputValue()), F: integerText(await details.locator('#fTicket').inputValue()) };
      } catch { /* Unknown current fare does not invalidate the observed Auto reference. */ }

      // Passive discovery only. Raw callbacks stay in memory long enough to validate
      // the native Save target, then only redacted evidence is persisted.
      const rawControls = await details.locator('button,input[type="button"],input[type="submit"]').evaluateAll(elements =>
        elements.filter(e => !!e.getClientRects().length).flatMap(e => {
          const id = e.id || '';
          const label = ((e as HTMLElement).innerText || (e as HTMLInputElement).value || '').replace(/\s+/g,' ').trim();
          if (!/(?:auto|price|ticket|fare|save|update|set)/i.test(`${id} ${label}`)) return [];
          return [{ id:id.slice(0,100), label:label.slice(0,100), tag:e.tagName, type:e.getAttribute('type'), raw:e.getAttribute('onclick') }];
        })
      );
      const controls = rawControls.map(({raw,...control}) => ({
        ...control,
        onclickShape: raw ? raw.replace(/\d+/g,'#').replace(/\s+/g,' ').trim().slice(0,300) : null
      }));
      const saves = rawControls.filter(control => /^save$/i.test(control.label));
      const saveControl = saves.length === 1
        ? inspectPricingSaveControl(saves[0].raw, item.aircraftId, item.routeId)
        : inspectPricingSaveControl(null, item.aircraftId, item.routeId);
      item.fares = { automatic, current, controls, saveControl, source: 'inspected-auto-control' };
    } catch {
      item.fares = { automatic: null, current: null, source: 'unavailable', issue: 'Referencia Auto nao confirmada.' };
    }
  }
}


/**
 * A second, clean, read-only scan is safer than merging partial pages from
 * multiple AJAX states. It never repeats a purchase, departure or mutation.
 * Only a complete, identity-checked scan with an unchanged total is usable.
 */
export async function collectFleetWithFreshRetry(
  page: Page,
  timeout = 10000,
  includeInflightDetails = false,
  retryDeadlineEpochMs?: number
): Promise<CollectionResult> {
  const first=await new DemandReader(page,timeout,includeInflightDetails).collect();
  if(first.complete || !first.warnings.some(w=>
    w.startsWith('PAGINATION_') ||
    w==='ROUTE_COUNT_MISMATCH' ||
    w==='COLLECTION_REASON:PAGINATION_DUPLICATE'
  )) return first;

  const minimumRemainingMs=240000;
  if(retryDeadlineEpochMs!==undefined && (
    !Number.isSafeInteger(retryDeadlineEpochMs) ||
    Date.now()+minimumRemainingMs>=retryDeadlineEpochMs
  )){
    first.warnings.push('FLEET_FRESH_RETRY_BUDGET_INSUFFICIENT');
    return first;
  }
  console.warn('[FleetFreshRetry] '+JSON.stringify({
    status:'START',observed:first.aircraft.length,expected:first.expectedRoutes
  }));
  try{
    // The first pass already tried native Fleet navigation. Reopening that
    // same JS/AJAX state again may reproduce the same broken pagination.
    // One normal browser reload resets transient client-side handlers while
    // retaining only the existing authenticated session; never re-login.
    await assertNoInteractiveChallenge(page,'fleet-reload:before');
    await page.reload({waitUntil:'domcontentloaded',timeout:Math.max(15000,timeout)});
    await assertNoInteractiveChallenge(page,'fleet-reload:after');
    await page.locator('#mapRoutes').waitFor({state:'visible',timeout:Math.max(15000,timeout)});
    await assertNoInteractiveChallenge(page,'fleet-reload:authenticated');
    console.warn('[FleetFreshRetry] '+JSON.stringify({status:'PAGE_RELOADED_AUTHENTICATED'}));
    await openFleetList(page,timeout);
    const second=await new DemandReader(page,timeout,includeInflightDetails).collect();
    const validSecond=second.complete &&
      second.expectedRoutes===first.expectedRoutes &&
      typeof second.expectedRoutes==='number' &&
      second.aircraft.length===second.expectedRoutes &&
      new Set(second.aircraft.map(a=>a.routeId)).size===second.expectedRoutes &&
      new Set(second.aircraft.map(a=>a.aircraftId)).size===second.expectedRoutes &&
      second.aircraft.every(a=>/^[1-9]\d*$/.test(a.aircraftId)&&/^[1-9]\d*$/.test(a.routeId));
    console.warn('[FleetFreshRetry] '+JSON.stringify({
      status:validSecond?'RECOVERED':'INCOMPLETE',
      firstObserved:first.aircraft.length,secondObserved:second.aircraft.length,
      firstExpected:first.expectedRoutes,secondExpected:second.expectedRoutes
    }));
    if(validSecond)return second;
    second.complete=false;
    second.warnings.push(
      second.expectedRoutes!==first.expectedRoutes
        ? 'FLEET_FRESH_RETRY_ROUTE_COUNT_CHANGED'
        : 'FLEET_FRESH_RETRY_INCOMPLETE'
    );
    if(first.aircraft.length>second.aircraft.length){
      first.warnings.push('FLEET_FRESH_RETRY_INCOMPLETE');
      return first;
    }
    return second;
  }catch(error){
    if(collectionFailureCode(error)==='INTERACTIVE_CHALLENGE_DETECTED_STOP')throw error;
    first.warnings.push('FLEET_FRESH_RETRY_FAILED:'+collectionFailureCode(error));
    return first;
  }
}
