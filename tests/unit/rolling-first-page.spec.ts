import { test, expect, type Page } from '@playwright/test';
import { FirstPageProgress, firstPageFingerprint, inspectFirstPageReadOnly } from '../../demand/rolling-first-page';
import type { FirstPageObservation } from '../../demand/rolling-first-page';

/** Synthetic browser only: all external HTTP requests blocked. */
async function fleetFixture(page:Page,options:{
  total?:number;visible?:number;duplicateAircraft?:boolean;duplicateRoute?:boolean;
  invalidDetails?:boolean
}={}){
  await page.route('**/*',route=>route.abort());
  const total=options.total??22,visible=options.visible??20;
  await page.setContent('<button id="mapRoutes" onclick="hideAllWhenClick();menuFleet(\'Routes\');">Fleet</button><div id="routeAction"></div>');
  await page.evaluate(({total,visible,duplicateAircraft,duplicateRoute,invalidDetails})=>{
    const w=window as any;
    w.fleetOpens=0;w.departures=0;w.pageAdvances=0;
    w.hideAllWhenClick=()=>{};
    w.menuFleet=()=>{
      w.fleetOpens++;
      const root=document.getElementById('routeAction')!;
      const container=document.createElement('div');
      container.id='routesContainer';
      container.innerHTML='<button>Routes ('+total+')</button>';
      for(let index=0;index<visible;index++){
        const routeId=duplicateRoute&&index===1?101:101+index;
        const aircraftId=duplicateAircraft&&index===1?201:201+index;
        const row=document.createElement('div');
        row.id='routeMainList'+routeId;
        row.className='row classPAX '+(index===0?'listDepartable':'');
        const a=document.createElement('a');
        a.setAttribute('onclick',invalidDetails&&index===0?'alert(0)':"playSound('neutral_click');Ajax('fleet_details.php?id="+aircraftId+"','detailsAction');if(intro==0){$('#routeAction').hide();}");
        const registration=document.createElement('span');
        registration.id='acRegList'+aircraftId;registration.textContent='TEST-'+aircraftId;
        a.append(registration,' - A340');
        row.append(a);
        if(index===0){
          const btn=document.createElement('button');btn.id='listDepart'+routeId;
          btn.textContent='Depart';btn.onclick=()=>{w.departures++;};
          row.append(btn);
        } else if(index===1)row.append('Onboard: 10 / 0 / 0');
        // Third and following rows are neither ready nor inflight: no
        // maintenance state is inferred from ambiguous Fleet-only evidence.
        container.append(row);
      }
      if(total>20){
        const nav=document.createElement('ul');nav.className='pagination';
        const next=document.createElement('a');next.href='#';next.textContent='Next';
        next.setAttribute('onclick',"Ajax('routes.php?start=20&sort=','routeAction',this);");
        nav.append(next);container.append(nav);
      }
      root.replaceChildren(container);
    };
  },{total,visible,duplicateAircraft:!!options.duplicateAircraft,
      duplicateRoute:!!options.duplicateRoute,invalidDetails:!!options.invalidDetails});
}

test('read-only first page captures native 20 without traversing or authorizing departures',async({page})=>{
  await fleetFixture(page);
  const snapshot=await inspectFirstPageReadOnly(page,2000);
  expect(snapshot.status).toBe('STABLE');
  expect(snapshot.routeTotal).toBe(22);
  expect(snapshot.visible).toBe(20);
  expect(snapshot.ready).toBe(1);
  expect(snapshot.aircraft[0].state).toBe('ready');
  expect(snapshot.aircraft[1].state).toBe('inflight');
  expect(snapshot.aircraft[2].state).toBe('unavailable');
  expect(snapshot.mutationAuthorized).toBe(false);
  expect(await page.evaluate(()=>(window as any).pageAdvances)).toBe(0);
  expect(await page.evaluate(()=>(window as any).departures)).toBe(0);
});

test('maintenance-style short first page never becomes a complete or actionable page',async({page})=>{
  await fleetFixture(page,{visible:19});
  const observation=await inspectFirstPageReadOnly(page,2000);
  expect(observation.status).toBe('SHORT_PAGE');
  const plan=new FirstPageProgress().plan(observation);
  expect(plan.status).toBe('WAIT_FOR_STABLE_PAGE');
  expect(plan.candidates).toEqual([]);
});

test('duplicate aircraft identity, duplicate route or unknown details callback fail closed',async({page})=>{
  for(const options of [{duplicateAircraft:true},{duplicateRoute:true},{invalidDetails:true}]){
    await fleetFixture(page,options);
    const snapshot=await inspectFirstPageReadOnly(page,2000);
    expect(snapshot.status).toBe('IDENTITY_UNVERIFIED');
    expect(new FirstPageProgress().plan(snapshot).candidates).toEqual([]);
  }
});

test('a reorder, arrival or landing changes the observed fingerprint without changing Routes(N)',()=>{
  const first={total:142,cards:[{aircraftId:'1',routeId:'11',registration:'A',state:'inflight' as const},
    {aircraftId:'2',routeId:'12',registration:'B',state:'ready' as const}]};
  const arrived={total:142,cards:[{...first.cards[0],state:'ready' as const},first.cards[1]]};
  const reordered={total:142,cards:[first.cards[1],first.cards[0]]};
  expect(firstPageFingerprint(first)).not.toBe(firstPageFingerprint(arrived));
  expect(firstPageFingerprint(first)).not.toBe(firstPageFingerprint(reordered));
});

test('confirmed/uncertain one-shot results are quarantined across first-page refreshes',()=>{
  const base:FirstPageObservation={status:'STABLE',routeTotal:142,visible:2,ready:2,mutationAuthorized:false,
    aircraft:[{aircraftId:'1',routeId:'11',registration:'A',state:'ready'},
      {aircraftId:'2',routeId:'12',registration:'B',state:'ready'}]};
  const tracker=new FirstPageProgress();
  expect(tracker.plan(base).candidates).toHaveLength(2);
  tracker.recordTerminalResult('1','11','departed');
  tracker.recordTerminalResult('2','12','uncertain');
  expect(tracker.plan(base).status).toBe('NO_NEW_READY');
  expect(tracker.plan(base).candidates).toEqual([]);
  expect(()=>tracker.recordTerminalResult('1','11','departed')).toThrow('FIRST_PAGE_RESULT_ALREADY_RECORDED');
  const next={...base,aircraft:[{...base.aircraft[0],state:'inflight' as const},
    {aircraftId:'3',routeId:'13',registration:'C',state:'ready' as const}]};
  expect(tracker.plan(next).candidates.map(x=>x.aircraftId)).toEqual(['3']);
  expect(tracker.plan({...base,status:'UNSTABLE'}).candidates).toEqual([]);
});
