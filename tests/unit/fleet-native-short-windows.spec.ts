import {expect,test,type Page} from '@playwright/test';
import {DemandReader} from '../../demand/reader';

/** Offline-only native Fleet fixture. Every Next is the game's inspected +20
 * callback even if the DOM contains fewer than 20 route cards. No game login,
 * external HTTP request, Depart, price change, or other mutation is possible.
 */
async function nativeShortWindowFleet(page:Page,windows:number[],reportedCount:number){
  await page.route('**/*',route=>route.abort());
  await page.setContent('<button>Routes ('+reportedCount+')</button><div id="routeAction"><div id="routesContainer"></div></div>');
  await page.evaluate(({counts})=>{
    const w=window as any;
    w.pageAdvances=0; w.mutations=0;
    let identity=1000;
    const pages=counts.map(count=>Array.from({length:count},()=>{
      identity++;return identity;
    }));
    w.renderNative=(index:number)=>{
      const root=document.getElementById('routesContainer')!;
      root.replaceChildren();
      for(const routeId of pages[index]){
        const aircraftId=routeId+30000;
        const row=document.createElement('div');
        row.id='routeMainList'+routeId;
        row.className='row classPAX';
        const label=document.createElement('span');
        label.className='s-text';label.textContent='AAA - BBB';
        row.append(label);
        const anchor=document.createElement('a');
        anchor.setAttribute('onclick',"playSound('neutral_click');Ajax('fleet_details.php?id="+aircraftId+"','detailsAction');if(intro==0){$('#routeAction').hide();}");
        const registration=document.createElement('span');
        registration.id='acRegList'+aircraftId;
        registration.textContent='TEST-'+routeId;
        anchor.append(registration);
        row.append(anchor);
        root.append(row);
      }
      if(index<pages.length-1){
        const pagination=document.createElement('div');
        pagination.className='pagination';
        const next=document.createElement('a');
        next.textContent='Next';next.href='#';
        next.setAttribute('onclick',"Ajax('routes.php?start="+((index+1)*20)+"&sort=','routeAction',this);");
        pagination.append(next);root.append(pagination);
      }
    };
    w.Ajax=(target:string)=>{
      const match=target.match(/^routes\.php\?start=(\d+)&sort=$/);
      if(!match){w.mutations++;return;}
      w.pageAdvances++;
      w.renderNative(Number(match[1])/20);
    };
    w.renderNative(0);
  },{counts:windows});
}

test('production #955 shape: seven native windows reconcile 113/113 identities beyond ceil(113/20)',async ({page})=>{
  await nativeShortWindowFleet(page,[15,13,15,14,19,19,18],113);
  const result=await new DemandReader(page,120).collect();
  expect(result.warnings).not.toContain('PAGINATION_OVERLAP_OR_INCOMPLETE');
  expect(result.complete).toBe(true);
  expect(result.expectedRoutes).toBe(113);
  expect(result.aircraft).toHaveLength(113);
  expect(new Set(result.aircraft.map(a=>a.routeId)).size).toBe(113);
  expect(new Set(result.aircraft.map(a=>a.aircraftId)).size).toBe(113);
  expect(await page.evaluate(()=>(window as any).pageAdvances)).toBe(6);
  expect(await page.evaluate(()=>(window as any).mutations)).toBe(0);
});

test('production #954 shape: short windows require seventh verified native offset for 111 identities',async ({page})=>{
  await nativeShortWindowFleet(page,[13,13,17,14,17,19,18],111);
  const result=await new DemandReader(page,120).collect();
  expect(result.complete).toBe(true);
  expect(result.aircraft).toHaveLength(111);
  expect(await page.evaluate(()=>(window as any).pageAdvances)).toBe(6);
  expect(await page.evaluate(()=>(window as any).mutations)).toBe(0);
});

test('short native windows never allow incomplete 112/113 fleet to pass',async ({page})=>{
  await nativeShortWindowFleet(page,[15,13,15,14,19,19,17],113);
  const result=await new DemandReader(page,120).collect();
  expect(result.complete).toBe(false);
  expect(result.aircraft).toHaveLength(112);
  expect(result.warnings).toContain('ROUTE_COUNT_MISMATCH');
  expect(await page.evaluate(()=>(window as any).mutations)).toBe(0);
});

test('complete native count keeps existing behavior for residual non-authoritative Next',async ({page})=>{
  await nativeShortWindowFleet(page,[3,1],3);
  const result=await new DemandReader(page,120).collect();
  expect(result.complete).toBe(true);
  expect(result.aircraft).toHaveLength(3);
  expect(await page.evaluate(()=>(window as any).pageAdvances)).toBe(0);
  expect(await page.evaluate(()=>(window as any).mutations)).toBe(0);
});

test('short-window inventory refuses duplicate aircraft IDs despite complete route count',async ({page})=>{
  await nativeShortWindowFleet(page,[19,2],21);
  await page.evaluate(()=>{
    const w=window as any;
    const original=w.renderNative;
    w.renderNative=(index:number)=>{
      original(index);
      if(index===1){
        const row=document.querySelector('#routesContainer [id^="routeMainList"]')!;
        const anchor=row.querySelector('a')!;
        anchor.setAttribute('onclick',"playSound('neutral_click');Ajax('fleet_details.php?id=31001','detailsAction');if(intro==0){$('#routeAction').hide();}");
        row.querySelector('[id^="acRegList"]')!.id='acRegList31001';
      }
    };
  });
  const result=await new DemandReader(page,120).collect();
  expect(result.complete).toBe(false);
  expect(result.warnings).toContain('FLEET_SHORT_WINDOW_IDENTITY_UNVERIFIED');
  expect(await page.evaluate(()=>(window as any).mutations)).toBe(0);
});

test('target lookup traverses short native windows without assuming initial page size',async ({page})=>{
  await nativeShortWindowFleet(page,[15,13,15,14,19,19,18],113);
  const {findFleetRoute}=await import('../../demand/navigation');
  await findFleetRoute(page,{routeId:'1113',aircraftId:'31113'} as any,120);
  expect(await page.locator('#routeMainList1113').isVisible()).toBe(true);
  expect(await page.evaluate(()=>(window as any).pageAdvances)).toBe(6);
  expect(await page.evaluate(()=>(window as any).mutations)).toBe(0);
});

test('production #957: extend after seventh short window and confirm all 115 identities',async ({page})=>{
  // Real #957 read 17+13+15+14+19+19=97, then 17/18 in page 7
  // while the native UI still exposed the inspected start=140 Next.
  // In this offline fixture the following page returns the final missing ID.
  await nativeShortWindowFleet(page,[17,13,15,14,19,19,17,1],115);
  const result=await new DemandReader(page,120).collect();
  expect(result.complete).toBe(true);
  expect(result.expectedRoutes).toBe(115);
  expect(result.aircraft).toHaveLength(115);
  expect(new Set(result.aircraft.map(a=>a.routeId)).size).toBe(115);
  expect(new Set(result.aircraft.map(a=>a.aircraftId)).size).toBe(115);
  expect(await page.evaluate(()=>(window as any).pageAdvances)).toBe(7);
  expect(await page.evaluate(()=>(window as any).mutations)).toBe(0);
});

test('production #957: missing last aircraft and no verified Next cannot authorize completion',async ({page})=>{
  await nativeShortWindowFleet(page,[17,13,15,14,19,19,17],115);
  const result=await new DemandReader(page,120).collect();
  expect(result.complete).toBe(false);
  expect(result.aircraft.length).toBeLessThan(115);
  expect(await page.evaluate(()=>(window as any).mutations)).toBe(0);
});

test('production #957: unexpected native offset cannot extend short tail',async ({page})=>{
  await nativeShortWindowFleet(page,[17,13,15,14,19,19,17,1],115);
  await page.evaluate(()=>{
    const w=window as any;
    const render=w.renderNative;
    w.renderNative=(index:number)=>{
      render(index);
      if(index===6){
        const next=document.querySelector('#routesContainer .pagination a')!;
        next.setAttribute('onclick',"Ajax('routes.php?start=141&sort=','routeAction',this);");
      }
    };
  });
  const result=await new DemandReader(page,120).collect();
  expect(result.complete).toBe(false);
  expect(result.aircraft.length).toBeLessThan(115);
  expect(await page.evaluate(()=>(window as any).pageAdvances)).toBe(6);
  expect(await page.evaluate(()=>(window as any).mutations)).toBe(0);
});
