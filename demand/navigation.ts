import { expect, Page } from '@playwright/test';
import { AircraftSnapshot } from './types';

export function routePageLimit(totalRoutes:number,pageSize=20){
  if(!Number.isSafeInteger(totalRoutes)||totalRoutes<0||!Number.isSafeInteger(pageSize)||pageSize<1||pageSize>100)
    throw new Error('ROUTE_PAGE_LIMIT_INVALID');
  return Math.max(1,Math.ceil(totalRoutes/pageSize));
}

/** Explicitly opens a fresh list: it does not pretend to preserve a previous pagination cursor. */
/** Read-only UI progression codes; an optional observer lets callers locate
 * a timeout without persisting page URLs, HTML, registrations or credentials.
 * No behavior change for existing production callers. */
export type FleetOpenStage =
 'INSPECT_CONTROL'|'CLICK_CONTROL'|'WAIT_OLD_CONTAINER_DETACH'|
 'WAIT_CONTAINER_VISIBLE'|'WAIT_ROUTE_CARDS_VISIBLE'|'VERIFY_QUOTE_CLOSED';
export async function openFleetList(
 page: Page, timeout: number, onStage: (stage:FleetOpenStage)=>void = () => {}
) {
  onStage('INSPECT_CONTROL');
  const menu = page.locator('#mapRoutes');
  const fleet = page.locator('#popBtn1');
  // The main Fleet menu TOGGLES the popup. Use its Fleet tab when already open.
  const tabOpen = await fleet.count() === 1 && await fleet.isVisible();
  const control = tabOpen ? fleet : menu;
  const allowed = tabOpen ? "$('.popMenuBtn').removeClass('active');$(this).addClass('active');$('#detailsAction').hide();Ajax('routes.php','routeAction',this,false,false);" : "hideAllWhenClick();menuFleet('Routes');";
  if (await control.count() !== 1 || !await control.isVisible() ||
    (await control.getAttribute('onclick') || '').replace(/\s/g,'') !== allowed) throw new Error('RESEARCH_LIST_CONTROL_UNVERIFIED');
  const previous = await page.locator('#routesContainer').count() === 1 ? await page.locator('#routesContainer').elementHandle() : null;
  try {
    onStage('CLICK_CONTROL');
    await control.click({timeout});
    // Prevent an old hidden list from satisfying the loading checks.
    if (previous) {
      onStage('WAIT_OLD_CONTAINER_DETACH');
      await expect.poll(() => previous.evaluate(e => e.isConnected),{timeout}).toBe(false);
    }
  } finally { await previous?.dispose(); }
  onStage('WAIT_CONTAINER_VISIBLE');
  await page.locator('#routesContainer').waitFor({state:'visible',timeout});
  onStage('WAIT_ROUTE_CARDS_VISIBLE');
  await expect.poll(async()=>page.locator('#routesContainer [id^="routeMainList"]').evaluateAll(es =>
    es.filter(e=>!!e.getClientRects().length).length
  ),{timeout}).toBeGreaterThan(0);
  onStage('VERIFY_QUOTE_CLOSED');
  if (await page.locator('#newRouteInfo').isVisible()) throw new Error('RESEARCH_QUOTE_NOT_CLOSED');
}

/** Return to an already-rendered native Fleet page ONLY when its current target
 * card is visible and the live route count still matches our verified inventory.
 * This skips a redundant Fleet reset and page replay for adjacent aircraft.
 * It never authorizes a mutation; DemandReader still reopens the target details
 * and validates its identity, demand, capacity and native Depart handler.
 */
export async function reuseCurrentFleetPageForTarget(
  page:Page, expected:AircraftSnapshot, expectedRoutes:number, timeout:number
):Promise<boolean>{
  if(!/^[1-9]\d*$/.test(expected.routeId)||!/^[1-9]\d*$/.test(expected.aircraftId)||
    !Number.isSafeInteger(expectedRoutes)||expectedRoutes<1)return false;
  const routeAction=page.locator('#routeAction');
  if(!await routeAction.isVisible()){
    const back=page.locator('#route-name .glyphicons-chevron-left');
    if(await back.count()!==1||!await back.isVisible())return false;
    await back.click({timeout});
    await routeAction.waitFor({state:'visible',timeout});
  }
  const container=page.locator('#routesContainer');
  if(!await container.isVisible())return false;
  const heading=page.getByRole('button',{name:/^Routes\s*\(\d+\)$/});
  if(await heading.count()!==1)return false;
  const label=(await heading.innerText({timeout})).trim();
  const matched=/^Routes\s*\((\d+)\)$/.exec(label);
  if(!matched||Number(matched[1])!==expectedRoutes)
    throw new Error('DEPARTURE_FLEET_COUNT_CHANGED');
  const row=container.locator('#routeMainList'+expected.routeId);
  if(await row.count()!==1||!await row.isVisible())return false;
  const callbacks=await row.locator('a').evaluateAll(es=>
    es.map(e=>e.getAttribute('onclick')||''));
  const matches=callbacks.filter(s=>{
    const callback=s.replace(/\s/g,'');
    return callback.includes("fleet_details.php?id="+expected.aircraftId+"'") &&
      callback.startsWith("playSound('neutral_click');Ajax('fleet_details.php?id=");
  });
  // If identity is missing/ambiguous, fall back to the normal fresh Fleet
  // navigation and let DemandReader reject any conflicting target.
  return matches.length===1;
}

export async function findFleetRoute(page: Page, aircraft: AircraftSnapshot, timeout: number) {
  const heading=(await page.getByRole('button',{name:/^Routes\s*\(\d+\)$/}).innerText({timeout})).trim();
  const matchCount=heading.match(/^Routes\s*\((\d+)\)$/);
  if(!matchCount)throw new Error('RESEARCH_ROUTE_COUNT_UNAVAILABLE');
  const totalRoutes=Number(matchCount[1]);
  const firstPageRows=await page.locator('#routesContainer [id^="routeMainList"]').evaluateAll(es =>
    es.filter(e=>!!e.getClientRects().length).length
  );
  if(totalRoutes>0&&firstPageRows<1)throw new Error('RESEARCH_ROUTE_COUNT_UNAVAILABLE');
  // The first rendered window is not a native page size: short windows can
  // leave additional exact +20 native offsets beyond ceil(Routes(N)/20).
  // This helper is read-only; its caller validates the route/aircraft identity.
  const maxPages=Math.min(64,Math.max(1,totalRoutes));
  const seen = new Set<string>();
  for (let index=0; index<maxPages; index++) {
    const currentHeading=(await page.getByRole('button',{name:/^Routes\s*\(\d+\)$/}).innerText({timeout})).trim();
    if(currentHeading!==`Routes (${totalRoutes})`)throw new Error('RESEARCH_FLEET_COUNT_CHANGED');
    const rows = page.locator('#routesContainer [id^="routeMainList"]');
    const first = await rows.evaluateAll(es=>es.find(e=>!!e.getClientRects().length)?.id || null);
    if (!first || seen.has(first)) throw new Error('RESEARCH_PAGINATION_INVALID');
    seen.add(first);
    const row = page.locator(`#routeMainList${aircraft.routeId}`);
    if (await row.count() === 1 && await row.isVisible()) return;
    if(index===maxPages-1)throw new Error('RESEARCH_ROUTE_NOT_FOUND');
    const next = page.locator('#routesContainer .pagination').getByRole('link',{name:'Next',exact:true});
    if (await next.count() !== 1) throw new Error('RESEARCH_ROUTE_NOT_FOUND');
    const callback = await next.getAttribute('onclick') || '';
    const match = callback.match(/^Ajax\('routes\.php\?start=(\d+)&sort=','routeAction',this\);$/);
    if (!match || Number(match[1]) !== (index+1)*20) throw new Error('RESEARCH_PAGINATION_CONTROL_UNVERIFIED');
    await next.click({timeout});
    await expect.poll(() => rows.evaluateAll(es=>es.find(e=>!!e.getClientRects().length)?.id || null),{timeout}).not.toBe(first);
  }
  throw new Error('RESEARCH_PAGINATION_LIMIT');
}

