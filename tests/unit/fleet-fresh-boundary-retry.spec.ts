import { test, expect, type Page } from '@playwright/test';
import { collectFleetWithFreshRetry, DemandReader } from '../../demand/reader';

/** A real-browser, entirely offline native +20 Fleet fixture.
 * Each reload is an independent DOM snapshot, with no access to the game.
 */
async function openFleetFixture(page: Page, mode: 'recover'|'always-overlap'|'duplicate-aircraft') {
  const html = `<!doctype html><html><body>
    <button id="mapRoutes" onclick="hideAllWhenClick();menuFleet('Routes');">Fleet</button>
    <div id="routeAction"><div id="routesContainer"></div></div>
    <script>
      const w=window;
      const loadNumber=Number(sessionStorage.getItem('fleetFixtureLoads')||'0')+1;
      sessionStorage.setItem('fleetFixtureLoads',String(loadNumber));
      w.mutations=0;
      const mode=${JSON.stringify(mode)};
      const overlapping=mode==='always-overlap'||(mode==='recover'&&loadNumber<3);
      const pages=[
        Array.from({length:20},(_,i)=>i+1),
        Array.from({length:20},(_,i)=>i+(overlapping?20:21)),
        [overlapping?40:41]
      ];
      w.hideAllWhenClick=()=>{};
      w.renderNative=(index)=>{
        const root=document.getElementById('routesContainer');
        root.replaceChildren();
        for(const routeId of pages[index]){
          const aircraftId=(mode==='duplicate-aircraft'&&routeId===41?25040:25000+routeId);
          const card=document.createElement('div');
          card.id='routeMainList'+routeId;
          card.className='row classPAX';
          const label=document.createElement('span');
          label.className='s-text';
          label.textContent='AAA - BBB';
          card.appendChild(label);
          const link=document.createElement('a');
          link.setAttribute('onclick',"playSound('neutral_click');Ajax('fleet_details.php?id="+aircraftId+"','detailsAction');if(intro==0){$('#routeAction').hide();}");
          const registration=document.createElement('span');
          registration.id='acRegList'+aircraftId;
          registration.textContent='TEST-'+routeId;
          link.appendChild(registration);
          card.appendChild(link);
          root.appendChild(card);
        }
        if(index<2){
          const pager=document.createElement('div');
          pager.className='pagination';
          const next=document.createElement('a');
          next.textContent='Next';
          next.href='#';
          next.setAttribute('onclick',"Ajax('routes.php?start="+((index+1)*20)+"&sort=','routeAction',this);");
          pager.appendChild(next);
          root.appendChild(pager);
        }
      };
      w.menuFleet=()=>{
        const old=document.getElementById('routesContainer');
        old.remove();
        const replacement=document.createElement('div');
        replacement.id='routesContainer';
        document.getElementById('routeAction').appendChild(replacement);
        w.renderNative(0);
      };
      w.Ajax=(url)=>{
        const next=/^routes\\.php\\?start=(\\d+)&sort=$/.exec(url);
        if(next) w.renderNative(Number(next[1])/20);
        else w.mutations++;
      };
      w.renderNative(0);
    </script>
  </body></html>`;
  await page.route('**/*', async route => {
    if (route.request().url() === 'https://fleet-fixture.test/fleet')
      await route.fulfill({status:200,contentType:'text/html',body:html});
    else await route.abort();
  });
  await page.goto('https://fleet-fixture.test/fleet');
}

test('production #996/#998/#1001: independent third snapshot may recover full 41/41 inventory', async ({page}) => {
  await openFleetFixture(page,'recover');
  const result=await collectFleetWithFreshRetry(page,120,false,Date.now()+600000);
  expect(result.complete).toBe(true);
  expect(result.expectedRoutes).toBe(41);
  expect(result.aircraft).toHaveLength(41);
  expect(new Set(result.aircraft.map(a=>a.routeId)).size).toBe(41);
  expect(new Set(result.aircraft.map(a=>a.aircraftId)).size).toBe(41);
  expect(await page.evaluate(()=>Number(sessionStorage.getItem('fleetFixtureLoads')))).toBe(3);
  expect(await page.evaluate(()=>(window as any).mutations)).toBe(0);
});

test('repeated overlap never stitches 40/41 observations across independent scans', async ({page}) => {
  await openFleetFixture(page,'always-overlap');
  const result=await collectFleetWithFreshRetry(page,120,false,Date.now()+600000);
  expect(result.complete).toBe(false);
  expect(result.aircraft).toHaveLength(40);
  expect(result.warnings).toContain('PAGINATION_BOUNDARY_OVERLAP_NOT_RECONCILED');
  expect(await page.evaluate(()=>Number(sessionStorage.getItem('fleetFixtureLoads')))).toBe(3);
  expect(await page.evaluate(()=>(window as any).mutations)).toBe(0);
});

test('deadline prevents additional reload when operational reserve would be consumed', async ({page}) => {
  await openFleetFixture(page,'always-overlap');
  const result=await collectFleetWithFreshRetry(page,120,false,Date.now()+120000);
  expect(result.complete).toBe(false);
  expect(result.warnings).toContain('FLEET_FRESH_RETRY_BUDGET_INSUFFICIENT');
  expect(await page.evaluate(()=>Number(sessionStorage.getItem('fleetFixtureLoads')))).toBe(1);
  expect(await page.evaluate(()=>(window as any).mutations)).toBe(0);
});

test('even full 41/41 route coverage cannot hide duplicated aircraft identity', async ({page}) => {
  await openFleetFixture(page,'duplicate-aircraft');
  const result=await new DemandReader(page,120).collect();
  expect(result.complete).toBe(false);
  expect(result.warnings).toContain('FLEET_INVENTORY_IDENTITY_UNVERIFIED');
  expect(result.aircraft).toHaveLength(41);
  expect(new Set(result.aircraft.map(a=>a.aircraftId)).size).toBe(40);
  expect(await page.evaluate(()=>(window as any).mutations)).toBe(0);
});
