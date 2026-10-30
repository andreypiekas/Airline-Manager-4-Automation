import { type Page } from '@playwright/test';
import { aircraftIdFromDetailsControl } from './identity';
import { openFleetList } from './navigation';
import { assertNoInteractiveChallenge } from '../utils/challenge-guard';

/**
 * A read-only prototype for a rolling, first-page dispatcher.
 *
 * A complete and fresh global fleet inventory remains necessary for the
 * existing production mutation path. A first-page observation is NOT a full
 * inventory and must never be supplied as a CollectionResult.complete=true.
 */
export interface FirstPageAircraft {
  aircraftId: string;
  routeId: string;
  registration: string;
  state: 'ready' | 'inflight' | 'unavailable';
}
export interface FirstPageObservation {
  status: 'STABLE' | 'UNSTABLE' | 'SHORT_PAGE' | 'IDENTITY_UNVERIFIED' | 'UI_UNVERIFIED';
  routeTotal: number | null;
  visible: number;
  ready: number;
  aircraft: FirstPageAircraft[];
  /** Permanent false: first-page evidence alone never authorizes a click. */
  mutationAuthorized: false;
}

interface WindowSample {
  total: number;
  cards: FirstPageAircraft[];
  invalid: boolean;
  cursorVerified: boolean;
}

export function firstPageFingerprint(sample: Pick<WindowSample, 'total' | 'cards'>): string {
  return JSON.stringify([sample.total, sample.cards.map(a => [
    a.aircraftId, a.routeId, a.registration, a.state
  ])]);
}

async function sampleFirstPage(page: Page, timeout: number): Promise<WindowSample | null> {
  await assertNoInteractiveChallenge(page, 'first-page-pilot:sample');
  const heading = page.getByRole('button', { name: /^Routes\s*\(\d+\)$/ });
  if (await heading.count() !== 1) return null;
  const raw = (await heading.innerText({ timeout })).trim();
  const match = /^Routes\s*\((\d+)\)$/.exec(raw);
  if (!match || !Number.isSafeInteger(Number(match[1])) || Number(match[1]) < 1) return null;
  const total = Number(match[1]);
  const rawCards = await page.locator('#routesContainer [id^="routeMainList"]').evaluateAll(elements =>
    elements.filter(el => !!el.getClientRects().length).map(el => {
      const buttons = Array.from(el.querySelectorAll('a'))
        .map(a => ({ callback: a.getAttribute('onclick') || '',
          registration: a.querySelector('[id^="acRegList"]')?.textContent?.trim() || '',
          registrationNodeId: a.querySelector('[id^="acRegList"]')?.id || '' }));
      const routeId = el.id.replace(/^routeMainList/, '');
      const depart = el.querySelector('#listDepart' + routeId) as HTMLElement | null;
      return {
        routeId,
        buttons,
        ready: el.classList.contains('classPAX') &&
          el.classList.contains('listDepartable') && !!depart &&
          !!depart.getClientRects().length && !(depart as HTMLButtonElement).disabled,
        inflight: /Onboard\s*:/.test((el as HTMLElement).innerText)
      };
    })
  );
  const cards: FirstPageAircraft[] = [];
  const rejectCounts:Record<string,number>={};
  const reject=(reason:string)=>{rejectCounts[reason]=(rejectCounts[reason]||0)+1;};
  let invalid = rawCards.length === 0 || rawCards.length > 20;
  if(invalid)reject('VISIBLE_CARD_COUNT_OUT_OF_RANGE');
  for (const rawCard of rawCards) {
    const matches = rawCard.buttons.map(b => ({
      id: aircraftIdFromDetailsControl(b.callback),
      registration: b.registration,
      registrationNodeId: b.registrationNodeId
    })).filter(b => b.id !== null);
    const routeValid=/^[1-9]\d*$/.test(rawCard.routeId);
    const detailsUnique=matches.length===1 && !!matches[0].id &&
      /^[1-9]\d*$/.test(matches[0].id);
    const registrationValid=detailsUnique &&
      matches[0].registrationNodeId==='acRegList'+matches[0].id &&
      !!matches[0].registration;
    const conflictingState=rawCard.ready&&rawCard.inflight;
    if(!routeValid||!detailsUnique||!registrationValid||conflictingState){
      if(!routeValid)reject('ROUTE_ID_UNVERIFIED');
      if(!detailsUnique)reject('DETAILS_CONTROL_IDENTITY_UNVERIFIED');
      if(detailsUnique&&!registrationValid)reject('REGISTRATION_IDENTITY_UNVERIFIED');
      if(conflictingState)reject('READY_INFLIGHT_STATE_CONFLICT');
      invalid = true;
      continue;
    }
    cards.push({
      aircraftId: matches[0].id!,
      routeId: rawCard.routeId,
      registration: matches[0].registration,
      state: rawCard.ready ? 'ready' : rawCard.inflight ? 'inflight' : 'unavailable'
    });
  }
  if(new Set(cards.map(a=>a.routeId)).size!==cards.length){
    invalid=true;reject('DUPLICATE_ROUTE_ID');
  }
  if(new Set(cards.map(a=>a.aircraftId)).size!==cards.length){
    invalid=true;reject('DUPLICATE_AIRCRAFT_ID');
  }
  if(cards.length!==rawCards.length){
    invalid=true;reject('UNVERIFIED_CARDS_PRESENT');
  }
  const next = page.locator('#routesContainer .pagination').getByRole('link', { name:'Next', exact:true });
  const nextCount = await next.count();
  const cursorVerified = total <= 20 ? nextCount === 0 : nextCount === 1 &&
    (await next.getAttribute('onclick') || '').replace(/\s/g, '') ===
      "Ajax('routes.php?start=20&sort=','routeAction',this);";
  if(!cursorVerified)reject('FIRST_PAGE_CURSOR_UNVERIFIED');
  if(invalid||!cursorVerified)console.warn('[FirstPageReadOnlyDiagnostic] '+JSON.stringify({
    status:'HOLD_FIRST_PAGE_IDENTITY_OR_CURSOR',
    visible:rawCards.length,validated:cards.length,
    nextLinks:nextCount,routeCountPresent:true,
    reasons:rejectCounts,globalComplete:false,mutationAuthorized:false
  }));
  return { total, cards, invalid, cursorVerified };
}

/** A native Fleet first page that is ALREADY rendered can be reused.
 * This prevents a redundant Fleet-tab click from waiting for a DOM container
 * detach when AM4 keeps the same #routesContainer node during Ajax refresh.
 * A later native page has Next(start=40+) or Previous and is never reused.
 * The two independent full-window identity reads still happen below. */
async function nativeFirstPageAlreadyVisible(page:Page):Promise<boolean> {
  const reject=(reason:string):false=>{
    console.warn('[FirstPageReuseDiagnostic] '+JSON.stringify({
      status:'REOPEN_REQUIRED',reason,globalComplete:false,mutationAuthorized:false
    }));
    return false;
  };
  const list=page.locator('#routeAction');
  const container=page.locator('#routesContainer');
  if(await list.count()!==1||!await list.isVisible()||
     await container.count()!==1||!await container.isVisible())return reject('FIRST_PAGE_SURFACE_NOT_VISIBLE');
  const heading=page.getByRole('button',{name:/^Routes\s*\(\d+\)$/});
  if(await heading.count()!==1)return reject('ROUTES_HEADING_NOT_UNIQUE');
  const value=(await heading.innerText({timeout:1500}).catch(()=>'' )).trim();
  const match=/^Routes\s*\((\d+)\)$/.exec(value);
  if(!match)return reject('ROUTES_HEADING_PARSE_UNVERIFIED');
  const total=Number(match[1]);
  if(!Number.isSafeInteger(total)||total<1)return reject('ROUTES_COUNT_INVALID');
  const pager=container.locator('.pagination');
  const previous=pager.getByRole('link',{name:'Previous',exact:true});
  if(await previous.count()>0)return reject('NATIVE_PREVIOUS_CURSOR_PRESENT');
  const next=pager.getByRole('link',{name:'Next',exact:true});
  if(total<=20)return await next.count()===0 || reject('UNEXPECTED_NEXT_CURSOR');
  const current=await next.count()===1 && await next.isVisible() &&
    (await next.getAttribute('onclick')||'').replace(/\s/g,'')===
      "Ajax('routes.php?start=20&sort=','routeAction',this);";
  return current || reject('NATIVE_FIRST_PAGE_NEXT_CURSOR_UNVERIFIED');
}

/**
 * Opens ONLY page 1, verifies it twice, and does not open details or click Depart.
 * Flights arriving/maintenance can reorder cards between samples even when
 * Routes(N) remains unchanged. Such a window is not stable evidence.
 */
export async function inspectFirstPageReadOnly(
  page: Page, timeout = 10000, options:{allowAlreadyOpen?:boolean}={}
): Promise<FirstPageObservation> {
  const blank = (status: FirstPageObservation['status']): FirstPageObservation => ({
    status, routeTotal:null, visible:0, ready:0, aircraft:[], mutationAuthorized:false
  });
  await assertNoInteractiveChallenge(page,'first-page-pilot:before');
  // The runner already opened page one. Do not reopen the Fleet tab when its
  // exact native first-page cursor is still verified: in the live game the
  // Ajax refresh may reuse the same container rather than detach it.
  if(options.allowAlreadyOpen===true && await nativeFirstPageAlreadyVisible(page)){
    console.log('[RollingFirstPageOpen] '+JSON.stringify({
      status:'REUSED_VERIFIED_NATIVE_FIRST_PAGE',fullFleetScan:false,mutationAuthorized:false
    }));
  }else{
    console.log('[RollingFirstPageOpen] '+JSON.stringify({
      status:'OPEN_NATIVE_FIRST_PAGE',fullFleetScan:false,mutationAuthorized:false
    }));
    // Revalidate by a fresh native Fleet request for subsequent target reads.
    // The in-place fallback still requires an actual successful routes.php
    // response, then TWO stable identity/cursor observations below.
    let lastStage='INSPECT_CONTROL';
    try{
      await openFleetList(page, timeout,stage=>{lastStage=stage;},
        {allowVerifiedInPlaceRefresh:true});
    }catch(error){
      // Never expose Playwright exception text, URLs or page HTML.
      const message=error instanceof Error?error.message:'';
      const code=['FLEET_REFRESH_NATIVE_RESPONSE_UNVERIFIED',
        'RESEARCH_LIST_CONTROL_UNVERIFIED','RESEARCH_QUOTE_NOT_CLOSED'].includes(message)
        ?message:/timeout|waiting for|expect\(/i.test(message)
          ?'UI_WAIT_TIMEOUT':'UNCLASSIFIED';
      console.warn('[FirstPageNativeOpenFailure] '+JSON.stringify({
        stage:lastStage,code,globalComplete:false,mutationAuthorized:false
      }));
      throw error;
    }
  }
  const first = await sampleFirstPage(page, timeout);
  if (!first) return blank('UI_UNVERIFIED');
  if (first.invalid || !first.cursorVerified) return {
    ...blank('IDENTITY_UNVERIFIED'), routeTotal:first.total, visible:first.cards.length
  };
  // A second independent DOM read catches mid-refresh changes without
  // assuming all future aircraft/positions stay fixed.
  const second = await sampleFirstPage(page, timeout);
  if (!second || second.invalid || !second.cursorVerified ||
      firstPageFingerprint(first) !== firstPageFingerprint(second)) return {
    ...blank('UNSTABLE'), routeTotal:first.total, visible:first.cards.length
  };
  const expected = Math.min(first.total,20);
  const status:FirstPageObservation['status'] = first.cards.length === expected ? 'STABLE' : 'SHORT_PAGE';
  return {
    status, routeTotal:first.total, visible:first.cards.length,
    ready:first.cards.filter(a => a.state === 'ready').length,
    aircraft:first.cards, mutationAuthorized:false
  };
}

/** Pure safety bookkeeping for a future rolling scheduler, not a dispatcher. */
export class FirstPageProgress {
  private readonly confirmedAircraft = new Set<string>();
  private readonly confirmedRoutes = new Set<string>();
  private readonly uncertainAircraft = new Set<string>();
  private readonly uncertainRoutes = new Set<string>();

  recordTerminalResult(aircraftId:string, routeId:string, state:'departed'|'uncertain') {
    if (!/^[1-9]\d*$/.test(aircraftId) || !/^[1-9]\d*$/.test(routeId)) throw Error('FIRST_PAGE_IDENTITY_INVALID');
    if (this.confirmedAircraft.has(aircraftId) || this.confirmedRoutes.has(routeId) ||
        this.uncertainAircraft.has(aircraftId) || this.uncertainRoutes.has(routeId))
      throw Error('FIRST_PAGE_RESULT_ALREADY_RECORDED');
    if (state === 'departed') {
      this.confirmedAircraft.add(aircraftId);this.confirmedRoutes.add(routeId);
    } else {
      this.uncertainAircraft.add(aircraftId);this.uncertainRoutes.add(routeId);
    }
  }

  plan(observation:FirstPageObservation):{
    status:'READ_ONLY_CANDIDATES'|'WAIT_FOR_STABLE_PAGE'|'NO_NEW_READY';
    candidates: FirstPageAircraft[];mutationAuthorized:false
  } {
    // A stable short native page can still identify candidates for read-only
    // analysis; it must NEVER be treated as complete Fleet proof or a click gate.
    if (!['STABLE','SHORT_PAGE'].includes(observation.status) || observation.mutationAuthorized !== false)
      return {status:'WAIT_FOR_STABLE_PAGE',candidates:[],mutationAuthorized:false};
    const candidates = observation.aircraft.filter(a=>a.state==='ready' &&
      !this.confirmedAircraft.has(a.aircraftId) && !this.confirmedRoutes.has(a.routeId) &&
      !this.uncertainAircraft.has(a.aircraftId) && !this.uncertainRoutes.has(a.routeId));
    return {status:candidates.length?'READ_ONLY_CANDIDATES':'NO_NEW_READY',
      candidates,mutationAuthorized:false};
  }
}
