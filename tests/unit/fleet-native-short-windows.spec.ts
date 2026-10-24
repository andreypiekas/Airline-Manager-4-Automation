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
      const match=target.match(/^routes\\.php\\?start=(\\d+)&sort=$/);
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

test('Routes(N) cannot declare success while another native page exists',async ({page})=>{
  await nativeShortWindowFleet(page,[3,1],3);
  const result=await new DemandReader(page,120).collect();
  expect(result.complete).toBe(false);
  expect(result.warnings).toContain('PAGINATION_MORE_PAGES_THAN_ROUTE_COUNT');
  expect(await page.evaluate(()=>(window as any).pageAdvances)).toBe(0);
  expect(await page.evaluate(()=>(window as any).mutations)).toBe(0);
});

test('full page with distinct routes but duplicate aircraft identities is never authorized',async ({page})=>{
  await nativeShortWindowFleet(page,[2],2);
  await page.evaluate(()=>{
    const cards=Array.from(document.querySelectorAll('#routesContainer [id^="routeMainList"]'));
    const first=cards[0].querySelector('a')!;
    const second=cards[1].querySelector('a')!;
    second.setAttribute('onclick',first.getAttribute('onclick')!);
    second.querySelector('[id^="acRegList"]')!.id=first.querySelector('[id^="acRegList"]')!.id;
  });
  const result=await new DemandReader(page,120).collect();
  expect(result.complete).toBe(false);
  expect(result.warnings).toContain('FLEET_AIRCRAFT_IDENTITY_INCOMPLETE_OR_DUPLICATE');
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
