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
  let invalid = rawCards.length === 0 || rawCards.length > 20;
  for (const rawCard of rawCards) {
    const matches = rawCard.buttons.map(b => ({
      id: aircraftIdFromDetailsControl(b.callback),
      registration: b.registration,
      registrationNodeId: b.registrationNodeId
    })).filter(b => b.id !== null);
    if (!/^[1-9]\d*$/.test(rawCard.routeId) || matches.length !== 1 ||
        !matches[0].id || !/^[1-9]\d*$/.test(matches[0].id) ||
        matches[0].registrationNodeId !== 'acRegList' + matches[0].id ||
        !matches[0].registration || (rawCard.ready && rawCard.inflight)) {
      invalid = true;
      continue;
    }
    cards.push({
      aircraftId: matches[0].id,
      routeId: rawCard.routeId,
      registration: matches[0].registration,
      state: rawCard.ready ? 'ready' : rawCard.inflight ? 'inflight' : 'unavailable'
    });
  }
  invalid ||= new Set(cards.map(a => a.routeId)).size !== cards.length ||
    new Set(cards.map(a => a.aircraftId)).size !== cards.length ||
    cards.length !== rawCards.length;
  const next = page.locator('#routesContainer .pagination').getByRole('link', { name:'Next', exact:true });
  const nextCount = await next.count();
  const cursorVerified = total <= 20 ? nextCount === 0 : nextCount === 1 &&
    (await next.getAttribute('onclick') || '').replace(/\s/g, '') ===
      "Ajax('routes.php?start=20&sort=','routeAction',this);";
  return { total, cards, invalid, cursorVerified };
}

/**
 * Opens ONLY page 1, verifies it twice, and does not open details or click Depart.
 * Flights arriving/maintenance can reorder cards between samples even when
 * Routes(N) remains unchanged. Such a window is not stable evidence.
 */
export async function inspectFirstPageReadOnly(page: Page, timeout = 10000): Promise<FirstPageObservation> {
  const blank = (status: FirstPageObservation['status']): FirstPageObservation => ({
    status, routeTotal:null, visible:0, ready:0, aircraft:[], mutationAuthorized:false
  });
  await assertNoInteractiveChallenge(page,'first-page-pilot:before');
  await openFleetList(page, timeout);
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
    if (observation.status !== 'STABLE' || observation.mutationAuthorized !== false)
      return {status:'WAIT_FOR_STABLE_PAGE',candidates:[],mutationAuthorized:false};
    const candidates = observation.aircraft.filter(a=>a.state==='ready' &&
      !this.confirmedAircraft.has(a.aircraftId) && !this.confirmedRoutes.has(a.routeId) &&
      !this.uncertainAircraft.has(a.aircraftId) && !this.uncertainRoutes.has(a.routeId));
    return {status:candidates.length?'READ_ONLY_CANDIDATES':'NO_NEW_READY',
      candidates,mutationAuthorized:false};
  }
}
