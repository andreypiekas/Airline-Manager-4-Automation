import { test, expect, type Page } from '@playwright/test';
import { inspectIndividualFirstPage } from '../../demand/rolling-individual-preflight';
import { DemandReader } from '../../demand/reader';

type Plane={route:number;aircraft:number;registration:string;ready:boolean};
async function fixture(page:Page,frames:Plane[][],total=132){
  await page.route('**/*',r=>r.abort()); // no live game or external requests
  await page.setContent(`<button id="mapRoutes" onclick="hideAllWhenClick();menuFleet('Routes');">Fleet</button>
    <div id="routeAction"></div><div id="detailsAction" style="display:none"></div>`);
  await page.evaluate(({frames,total})=>{
    const w=window as any;w.opens=0;w.departures=0;w.detailsOpened=0;w.hideAllWhenClick=()=>{};
    w.menuFleet=()=>{
      const frame=frames[Math.min(w.opens++,frames.length-1)];
      const container=document.createElement('div');container.id='routesContainer';
      const heading=document.createElement('button');heading.textContent='Routes ('+total+')';container.append(heading);
      frame.forEach(p=>{
        const row=document.createElement('div');row.className='row classPAX'+(p.ready?' listDepartable':'');
        row.id='routeMainList'+p.route;
        const label=document.createElement('span');label.className='s-text';label.textContent='AAA - BBB';row.append(label);
        const a=document.createElement('a');a.setAttribute('onclick',
          "playSound('neutral_click');Ajax('fleet_details.php?id="+p.aircraft+"','detailsAction');if(intro==0){$('#routeAction').hide();}");
        a.innerHTML='<span id="acRegList'+p.aircraft+'">'+p.registration+'</span> - Test aircraft';row.append(a);
        if(p.ready){const btn=document.createElement('button');btn.id='listDepart'+p.route;btn.textContent='Depart';
          btn.onclick=()=>{w.departures++;};row.append(btn);}
        else row.append('Onboard: 20 / 0 / 0');
        container.append(row);
      });
      const pager=document.createElement('ul');pager.className='pagination';const next=document.createElement('a');
      next.textContent='Next';next.setAttribute('onclick',"Ajax('routes.php?start=20&sort=','routeAction',this);");
      pager.append(next);container.append(pager);
      document.getElementById('routeAction')!.replaceChildren(container);
      document.getElementById('detailsAction')!.style.display='none';
    };
    w.playSound=()=>{};w.intro=0;w.$=(selector:string)=>({hide(){(document.querySelector(selector) as HTMLElement).style.display='none';}});
    w.Ajax=()=>{w.detailsOpened++;};
  },{frames,total});
}
const plane=(id:number,ready:boolean):Plane=>({route:1000+id,aircraft:2000+id,registration:'TEST-'+id,ready});

test('inflight-only window is safe with no scans of other pages or any departure click',async({page})=>{
  await fixture(page,[[plane(1,false),plane(2,false)]]);
  const r=await inspectIndividualFirstPage(page,{timeout:500,maxCandidates:2});
  expect(r).toMatchObject({mode:'read-only-individual',mutationAuthorized:false,inspected:0,verified:0,readyCandidates:0});
  expect(await page.evaluate(()=>(window as any).departures)).toBe(0);
  expect(await page.evaluate(()=>(window as any).opens)).toBe(1);
});
test('arrival reorder removes candidate on next first-page scan: no detail opens',async({page})=>{
  const same=[plane(1,true),plane(2,false)];
  const changed=[plane(3,true),plane(2,false)];
  await fixture(page,[same,changed]);
  const r=await inspectIndividualFirstPage(page,{timeout:500,maxCandidates:2});
  expect(r.verified).toBe(0);
  expect(r.holds).toEqual([{code:'TARGET_MOVED_OR_CHANGED'}]);
  expect(await page.evaluate(()=>(window as any).detailsOpened)).toBe(0);
  expect(await page.evaluate(()=>(window as any).departures)).toBe(0);
});
test('duplicate aircraft identity in the visible page fails closed',async({page})=>{
  const duplicate=[plane(1,true),{...plane(2,true),aircraft:2001}];
  await fixture(page,[duplicate]);
  const r=await inspectIndividualFirstPage(page,{timeout:500,maxCandidates:2});
  expect(r.window).toBe('UNVERIFIED');
  expect(r.holds).toEqual([{code:'WINDOW_UNVERIFIED'}]);
  expect(await page.evaluate(()=>(window as any).detailsOpened)).toBe(0);
});
test('insufficient execution budget avoids even opening Fleet UI',async({page})=>{
  await fixture(page,[[plane(1,true)]]);
  const r=await inspectIndividualFirstPage(page,{timeout:500,maxCandidates:1,deadlineEpochMs:Date.now()+500});
  expect(r.window).toBe('TIME_BUDGET');
  expect(await page.evaluate(()=>(window as any).opens)).toBe(0);
  expect(await page.evaluate(()=>(window as any).departures)).toBe(0);
});
test('target with an ambiguous route card cannot be promoted to a valid individual observation',async({page})=>{
  await fixture(page,[[plane(1,true)]]);
  await page.evaluate(()=>{(window as any).menuFleet=()=>{
    (window as any).opens++;
    const root=document.createElement('div');root.id='routesContainer';
    root.innerHTML='<button>Routes (132)</button><div id="routeMainList1001" class="row classPAX listDepartable"><span class="s-text">AAA - BBB</span><a onclick="playSound(\'neutral_click\');Ajax(\'fleet_details.php?id=2001\',\'detailsAction\');if(intro==0){$(\'#routeAction\').hide();}"><span id="acRegList2001">TEST-1</span></a><a onclick="playSound(\'neutral_click\');Ajax(\'fleet_details.php?id=2002\',\'detailsAction\');if(intro==0){$(\'#routeAction\').hide();}">ambiguous</a><button id="listDepart1001">Depart</button></div><ul class="pagination"><a onclick="Ajax(\'routes.php?start=20&sort=\',\'routeAction\',this);">Next</a></ul>';
    document.getElementById('routeAction')!.replaceChildren(root);
  };});
  const r=await inspectIndividualFirstPage(page,{timeout:500,maxCandidates:1});
  expect(r.window).toBe('UNVERIFIED');
  expect(r.verified).toBe(0);
  expect(await page.evaluate(()=>(window as any).detailsOpened)).toBe(0);
});
