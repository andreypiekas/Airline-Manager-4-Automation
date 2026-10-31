import { test, expect, type Page } from '@playwright/test';
import { inspectFirstPageReadOnly } from '../../demand/rolling-first-page';
import { inspectIndividualFirstPage } from '../../demand/rolling-individual-preflight';
import { observeRollingFirstPage } from '../../demand/rolling-first-page-cycle';

type Card = { id:number; state:'ready'|'inflight'|'unavailable' };
const first=(firstState:Card['state']):Card[]=>Array.from({length:20},(_,i)=>({
  id:i+1,state:i===0?firstState:'unavailable'
}));

/**
 * A local-only emulation of the AM4 Fleet menu:
 * every menu open replaces the first native page, like a route list refreshed
 * after landing / maintenance. It never serves a second page.
 */
async function changingFleet(page:Page, frames:Card[][],total=142){
  await page.route('**/*', route=>route.abort());
  await page.setContent('<button id="mapRoutes" onclick="hideAllWhenClick();menuFleet(\'Routes\');">Fleet</button><div id="routeAction"></div>');
  await page.evaluate(({frames,total})=>{
    const w=window as any;
    w.opens=0;w.nextClicks=0;w.departures=0;
    w.hideAllWhenClick=()=>{};
    w.menuFleet=()=>{
      const n=Math.min(w.opens++,frames.length-1);
      const cards=frames[n];
      const wrapper=document.createElement('div');
      wrapper.id='routesContainer';
      const heading=document.createElement('button');
      heading.textContent='Routes ('+total+')';
      wrapper.append(heading);
      for(const card of cards){
        const routeId=1000+card.id,aircraftId=2000+card.id;
        const row=document.createElement('div');
        row.id='routeMainList'+routeId;
        row.className='row classPAX'+(card.state==='ready'?' listDepartable':'');
        const link=document.createElement('a');
        link.setAttribute('onclick',"playSound('neutral_click');Ajax('fleet_details.php?id="+aircraftId+"','detailsAction');if(intro==0){$('#routeAction').hide();}");
        const reg=document.createElement('span');
        reg.id='acRegList'+aircraftId;
        reg.textContent='TEST-'+card.id;
        link.append(reg,' - aircraft');
        row.append(link);
        if(card.state==='ready'){
          const btn=document.createElement('button');
          btn.textContent='Depart';btn.id='listDepart'+routeId;
          btn.onclick=()=>{w.departures++;};
          row.append(btn);
        } else if(card.state==='inflight') {
          row.append('Onboard: 45 / 0 / 0');
        }
        wrapper.append(row);
      }
      const nav=document.createElement('ul');nav.className='pagination';
      const next=document.createElement('a');
      next.href='#';next.textContent='Next';
      next.setAttribute('onclick',"Ajax('routes.php?start=20&sort=','routeAction',this);");
      next.addEventListener('click',()=>{w.nextClicks++;});
      nav.append(next);
      wrapper.append(nav);
      document.getElementById('routeAction')!.replaceChildren(wrapper);
    };
  },{frames,total});
}

test('natural landing changes first page while collector never traverses a second page',async({page})=>{
  const idle=first('inflight');
  const landed=first('ready');
  const swapped=first('inflight');
  swapped[1]={id:21,state:'ready'};
  await changingFleet(page,[idle,landed,swapped]);
  const report=await observeRollingFirstPage(
    ()=>inspectFirstPageReadOnly(page,1500),
    {maxWindows:3,maxConsecutiveWithoutNewReady:2}
  );
  expect(report.windows.map(x=>x.newlyReady)).toEqual([0,1,1]);
  expect(report.totalKnownAircraft).toBe(21);
  expect(report.windows.map(x=>x.routeTotal)).toEqual([142,142,142]);
  expect(report.mutationAuthorized).toBe(false);
  expect(await page.evaluate(()=>(window as any).opens)).toBe(3);
  expect(await page.evaluate(()=>(window as any).nextClicks)).toBe(0);
  expect(await page.evaluate(()=>(window as any).departures)).toBe(0);
});

test('maintenance-style short window is observed without claiming full fleet integrity',async({page})=>{
  await changingFleet(page,[first('ready').slice(0,19)]);
  const report=await observeRollingFirstPage(
    ()=>inspectFirstPageReadOnly(page,1500),
    {maxWindows:4,maxConsecutiveWithoutNewReady:2}
  );
  expect(report.windows[0].status).toBe('SHORT_PAGE');
  expect(report.windows[0].newlyReady).toBe(1);
  expect(report.stopReason).toBe('NO_NEW_READY');
  expect(report.totalKnownAircraft).toBe(19);
  expect(report.mutationAuthorized).toBe(false);
  expect(await page.evaluate(()=>(window as any).nextClicks)).toBe(0);
  expect(await page.evaluate(()=>(window as any).departures)).toBe(0);
});

// Regression #1252: two confirmed departures were followed by an incomplete
// native first-page observation. Recheck once without authorizing a click.
test('short first page with no ready cards gets one read-only recovery to a stable empty window',async({page})=>{
  const short=first('unavailable').slice(0,19);
  const stable=first('unavailable');
  await changingFleet(page,[short,stable]);
  const report=await inspectIndividualFirstPage(page,{timeout:1500,maxCandidates:20});
  expect(report.window).toBe('STABLE');
  expect(report.routeTotal).toBe(142);
  expect(report.readyCandidates).toBe(0);
  expect(report.verified).toBe(0);
  expect(report.holds).toEqual([]);
  expect(await page.evaluate(()=>(window as any).opens)).toBe(2);
  expect(await page.evaluate(()=>(window as any).nextClicks)).toBe(0);
  expect(await page.evaluate(()=>(window as any).departures)).toBe(0);
});

test('repeated short no-ready first pages stay unverified, never treated as complete',async({page})=>{
  const short=first('unavailable').slice(0,19);
  await changingFleet(page,[short,short]);
  const report=await inspectIndividualFirstPage(page,{timeout:1500,maxCandidates:20});
  expect(report.window).toBe('SHORT_PAGE');
  expect(report.routeTotal).toBe(142);
  expect(report.readyCandidates).toBe(0);
  expect(report.verified).toBe(0);
  expect(await page.evaluate(()=>(window as any).opens)).toBe(2);
  expect(await page.evaluate(()=>(window as any).nextClicks)).toBe(0);
  expect(await page.evaluate(()=>(window as any).departures)).toBe(0);
});
