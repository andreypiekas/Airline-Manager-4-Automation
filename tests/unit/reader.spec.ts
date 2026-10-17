import { test, expect, Page } from '@playwright/test';
import { DemandReader, collectFleetWithFreshRetry } from '../../demand/reader';
import { FleetUtils } from '../../utils/fleet.utils';
import { runDemandSimulation } from '../../demand/run';
import { readDemandConfig } from '../../demand/config';
import { readFile } from 'node:fs/promises';
import { findFleetRoute, openFleetList, routePageLimit } from '../../demand/navigation';

interface FixtureOptions { operational?: boolean; missingCabin?: boolean; badDemand?: boolean; wrongIdentity?: boolean; pages?: number; badCount?: boolean; loop?: boolean; staleNext?: boolean; missingDetails?: boolean; unknownAuto?: boolean }
async function fixture(page: Page, options: FixtureOptions = {}) {
  await page.route('**/*', route => route.abort()); // Absolutely no game or other network access.
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.setContent(String.raw`<button>Routes (${options.badCount ? 9 : options.pages === 2 ? 3 : 2})</button>
    <button id="popBtn1" onclick="$('.popMenuBtn').removeClass('active');$(this).addClass('active');$('#detailsAction').hide();Ajax('routes.php','routeAction',this,false,false);">Fleet</button>
    <div id="routeAction"><div id="routesContainer"></div></div><div id="detailsAction" style="display:none"></div>
    <script>
    window.mutations=0;
    window.ticketPriceSuggest=()=>window.mutations++;
    const options=${JSON.stringify(options)};
    function render(index=0) {
      document.getElementById('routeAction').style.display='block';
      document.getElementById('detailsAction').style.display='none';
      const ids=index===0 ? [101,102] : [103];
      document.getElementById('routesContainer').innerHTML='<button id="departAll" onclick="window.mutations++">Depart all</button>'+ids.map(id=>
        '<div class="row classPAX '+(id===102?'':'listDepartable')+'" id="routeMainList'+id+'">'+
        '<span class="s-text">AAA - BBB</span><a href="#" onclick="playSound(\'neutral_click\');Ajax(\'fleet_details.php?id='+(id+1000)+'\',\'detailsAction\');if(intro==0) {$(\'#routeAction\').hide();}"><span id="acRegList'+(id+1000)+'">TEST-'+id+'</span> - Test aircraft</a>'+
        (id===102?'Onboard: 40 / 0 / 0':'Demand: 90 / 0 / 0 <button id="listDepart'+id+'" onclick="window.mutations++">Depart</button>')+'</div>').join('')+
        '<ul class="pagination">'+(options.pages===2&&(index===0||options.staleNext)?'<a href="#" onclick="render('+(options.loop?0:index+1)+');return false">Next</a>':'')+'</ul>';
    }
    const intro=0; function playSound(){} function $(selector){return {removeClass(){return this},addClass(){return this},hide(){const el=document.querySelector(selector);if(el)el.style.display='none';return this}}} function Ajax(url){if(url==='routes.php'){const old=document.getElementById('routesContainer');const fresh=document.createElement('div');fresh.id='routesContainer';old.replaceWith(fresh);render(0);return;}show(Number(url.split('id=')[1])-1000)}
    function show(id) {
      if(options.missingDetails) return;
      document.getElementById('routeAction').style.display='none';
      const d=document.getElementById('detailsAction');
      d.style.display='block';
      d.innerHTML='<div id="route-name"><span class="glyphicons-chevron-left" onclick="document.getElementById(\'detailsAction\').style.display=\'none\';document.getElementById(\'routeAction\').style.display=\'block\'">Back</span></div>'+
      '<span id="ff-name">TEST-'+id+'</span>'+
      '<button id="routeViewDepart" onclick="window.mutations++; /* route_depart.php?id='+(options.wrongIdentity?999:id)+'&ref=list */">Depart</button>'+
      '<button id="routeViewGround_unground" onclick="window.mutations++">Ground</button>'+
      '<div class="col-5"><span class="l-text">BBB</span></div><div class="col-5"><span class="l-text">AAA</span></div>'+
      '<div onclick="document.getElementById(\'seat-layout\').style.display=\'block\'">Seat layout</div>'+
      '<div id="seat-layout" style="display:none">'+['economy','business','first'].map((c,i)=>'<div><img src="assets/'+c+'_seat.png"><br>'+(i?0:100)+'<div>$<input value="9999"></div></div>').join('')+'</div>'+
      '<div>Todays demand</div><div id="list-demand">'+['economy','business','first'].filter((c,i)=>!options.missingCabin||i!==1).map((c,i)=>'<div><img src="assets/'+c+'_seat.png"><br>'+(i?'0/200':options.badDemand?'90/not-a-number':'90/1000')+'</div>').join('')+'</div>';
      if(id===102) {
        d.querySelector('#routeViewDepart').remove();
        d.insertAdjacentHTML('beforeend', '<span id="timer">00:18:37</span><button onclick="/* fleet_details.php?id=1102&mode=reg& */">Rename aircraft</button><button onclick="/* fleet_details.php?id=102&mode=routeReg& */">Rename route</button>');
        d.querySelectorAll('.col-5 .l-text').forEach((e,i)=>e.textContent=i?'BBB':'AAA');
      }
      if(options.operational) d.insertAdjacentHTML('beforeend', '<span class="s-text">Range</span><br><span class="m-text">3,440km</span><br><span class="s-text">Min runway</span><br><span class="m-text">7,550ft</span><br><span class="s-text">Flight hours/Cycles</span><br><span class="m-text">682 / 206</span>');
      d.querySelector('#seat-layout').insertAdjacentHTML('beforeend', '<button onclick="'+(options.unknownAuto?'unknownCallback()':'ticketPriceSuggest(1234,3456,17890,this,291);')+'">Auto</button><button onclick="window.mutations++">Save</button>');
      d.querySelectorAll('#seat-layout input').forEach((el,i)=>el.id=['eTicket','bTicket','fTicket'][i]);
    }
    render();
    </script>`);
  expect(errors).toEqual([]);
  await expect(page.locator('#routeMainList101')).toBeVisible();
}

async function nativeIncompleteFirstPage(page:Page,completes:boolean){
  await page.route('**/*',route=>route.abort());
  await page.setContent('<button>Routes (21)</button><div id="routeAction"><div id="routesContainer"></div></div>');
  await page.evaluate((finish)=>{
    const w=window as any;w.mutations=0;w.pageAdvances=0;
    w.renderPage=(pageNumber:number)=>{
      const root=document.querySelector('#routesContainer')!;
      root.replaceChildren();
      const append=(n:number)=>{
        const id=100+n,row=document.createElement('div');
        row.id='routeMainList'+id;row.className='row';
        row.innerHTML='<span class="s-text">AAA - BBB</span>';
        const link=document.createElement('a');
        link.setAttribute('onclick',"playSound('neutral_click');Ajax('fleet_details.php?id="+(1000+id)+"','detailsAction');if(intro==0){$('#routeAction').hide();}");
        const registration=document.createElement('span');
        registration.id='acRegList'+(1000+id);registration.textContent='TEST-'+id;
        link.append(registration,' - Test aircraft');row.append(link);
        root.append(row);
      };
      if(pageNumber===0){
        for(let i=1;i<=18;i++)append(i);
        if(finish)setTimeout(()=>{append(19);append(20);},100);
        const p=document.createElement('ul');p.className='pagination';
        p.innerHTML='<a href="#">Next</a>';
        p.querySelector('a')!.setAttribute('onclick',"Ajax('routes.php?start=20&sort=','routeAction',this);");
        root.append(p);
      }else append(21);
    };
    w.Ajax=(url:string)=>{
      if(url==="routes.php?start=20&sort="){w.pageAdvances++;w.renderPage(1);}
    };
    w.renderPage(0);
  },completes);
}
test('native first page waits for all twenty visible routes before advancing',async({page})=>{
  await nativeIncompleteFirstPage(page,true);
  const r=await new DemandReader(page,750).collect();
  expect(r.complete).toBe(true);
  expect(r.aircraft).toHaveLength(21);
  expect(r.aircraft.map(a=>a.routeId)).toEqual(Array.from({length:21},(_,i)=>String(101+i)));
  expect(await page.evaluate(()=>(window as any).pageAdvances)).toBe(1);
  expect(await page.evaluate(()=>(window as any).mutations)).toBe(0);
});
test('permanently truncated native first page remains blocked after read-only pagination',async({page})=>{
  await nativeIncompleteFirstPage(page,false);
  const r=await new DemandReader(page,250).collect();
  expect(r.complete).toBe(false);
  expect(r.warnings).toContain('PAGINATION_INITIAL_PAGE_INCOMPLETE');
  expect(r.aircraft).toHaveLength(19); // native final page is captured read-only; collection remains blocked
  expect(await page.evaluate(()=>(window as any).pageAdvances)).toBe(1);
  expect(await page.evaluate(()=>(window as any).mutations)).toBe(0);
});


async function nativeShortWindowFixture(page:Page,lastPageSize:number,shortPageIndex=0,validCursor=true,boundaryRepeat=false,conflictingAircraft=false,totalRoutes=66){
  await page.route('**/*',route=>route.abort());
  await page.setContent('<button>Routes ('+totalRoutes+')</button><div id="routeAction"><div id="routesContainer"></div></div>');
  await page.evaluate(({lastSize,shortAt,cursorValid,boundary,conflict})=>{
    const w=window as any;
    w.pageAdvances=0;w.mutations=0;
    w.renderNative=(offset:number)=>{
      const root=document.querySelector('#routesContainer')!;
      root.replaceChildren();
      const pageIndex=offset/20;
      const count=boundary?(pageIndex===0||pageIndex===2?19:pageIndex===3?lastSize:20):
        pageIndex===shortAt?19:pageIndex===3?lastSize:20;
      const first=boundary?[1,19,39,58][pageIndex]:
        shortAt===0?[1,20,40,60][pageIndex]:[1,21,41,60][pageIndex];
      for(let j=0;j<count;j++){
        const id=first+j+100,aircraftId=id+1000+(boundary&&conflict&&pageIndex===1&&j===0?5000:0);
        const row=document.createElement('div');
        row.id='routeMainList'+id;
        row.className='row classPAX';
        row.innerHTML='<span class="s-text">AAA - BBB</span>';
        const link=document.createElement('a');
        link.setAttribute('onclick',"playSound('neutral_click');Ajax('fleet_details.php?id="+aircraftId+"','detailsAction');if(intro==0){$('#routeAction').hide();}");
        const reg=document.createElement('span');
        reg.id='acRegList'+aircraftId;reg.textContent='TEST-'+id;
        link.append(reg,' - Test aircraft');row.append(link);
        root.append(row);
      }
      if(pageIndex<3){
        const pager=document.createElement('ul');pager.className='pagination';
        const next=document.createElement('a');next.textContent='Next';next.href='#';
        next.setAttribute('onclick',"Ajax('routes.php?start="+(cursorValid||pageIndex!==shortAt?offset+20:offset+21)+"&sort=','routeAction',this);");
        pager.append(next);root.append(pager);
      }
    };
    w.Ajax=(target:string)=>{
      const match=target.match(/^routes\.php\?start=(\d+)&sort=$/);
      if(match){w.pageAdvances++;w.renderNative(Number(match[1]));}
    };
    w.renderNative(0);
  },{lastSize:lastPageSize,shortAt:shortPageIndex,cursorValid:validCursor,boundary:boundaryRepeat,conflict:conflictingAircraft});
}
test('19-row native first page can reconcile when all 66 unique aircraft are later visible',async({page})=>{
  await nativeShortWindowFixture(page,7);
  const result=await new DemandReader(page,70).collect();
  expect(result.complete).toBe(true);
  expect(result.aircraft).toHaveLength(66);
  expect(new Set(result.aircraft.map(a=>a.aircraftId)).size).toBe(66);
  expect(await page.evaluate(()=>(window as any).pageAdvances)).toBe(3);
  expect(await page.evaluate(()=>(window as any).mutations)).toBe(0);
});
test('19-row first page never authorizes inventory completion when one route is missing',async({page})=>{
  await nativeShortWindowFixture(page,6);
  const result=await new DemandReader(page,70).collect();
  expect(result.complete).toBe(false);
  expect(result.aircraft).toHaveLength(65); // native last 6/6 is valid; 65/66 still fails closed
  expect(result.warnings).toContain('PAGINATION_INITIAL_PAGE_INCOMPLETE');
  expect(await page.evaluate(()=>(window as any).pageAdvances)).toBe(3);
  expect(await page.evaluate(()=>(window as any).mutations)).toBe(0);
});

test('19-route third native page reconciles only after all 66 unique aircraft are read',async({page})=>{
  await nativeShortWindowFixture(page,7,2);
  const result=await new DemandReader(page,90).collect();
  expect(result.complete).toBe(true);
  expect(result.expectedRoutes).toBe(66);
  expect(result.aircraft).toHaveLength(66);
  expect(new Set(result.aircraft.map(a=>a.routeId)).size).toBe(66);
  expect(new Set(result.aircraft.map(a=>a.aircraftId)).size).toBe(66);
  expect(await page.evaluate(()=>(window as any).pageAdvances)).toBe(3);
  expect(await page.evaluate(()=>(window as any).mutations)).toBe(0);
});
test('19-route third page with 65 unique aircraft remains blocked',async({page})=>{
  await nativeShortWindowFixture(page,6,2);
  const result=await new DemandReader(page,90).collect();
  expect(result.complete).toBe(false);
  expect(result.expectedRoutes).toBe(66);
  expect(result.aircraft.length).toBeLessThan(66);
  expect(result.warnings).toContain('PAGINATION_INTERMEDIATE_PAGE_INCOMPLETE');
  expect(result.warnings).toContain('ROUTE_COUNT_MISMATCH');
  expect(await page.evaluate(()=>(window as any).pageAdvances)).toBe(3);
  expect(await page.evaluate(()=>(window as any).mutations)).toBe(0);
});
test('short intermediate page with unverified native Next never authorizes a collection',async({page})=>{
  await nativeShortWindowFixture(page,7,2,false);
  const result=await new DemandReader(page,90).collect();
  expect(result.complete).toBe(false);
  expect(result.aircraft.length).toBeLessThan(66);
  expect(await page.evaluate(()=>(window as any).mutations)).toBe(0);
});

test('single duplicated boundary card after short page reconciles if all 66 identities verified',async({page})=>{
  await nativeShortWindowFixture(page,9,0,true,true);
  const r=await new DemandReader(page,90).collect();
  expect(r.complete).toBe(true);
  expect(r.aircraft).toHaveLength(66);
  expect(new Set(r.aircraft.map(a=>a.routeId)).size).toBe(66);
  expect(new Set(r.aircraft.map(a=>a.aircraftId)).size).toBe(66);
  expect(await page.evaluate(()=>(window as any).pageAdvances)).toBe(3);
  expect(await page.evaluate(()=>(window as any).mutations)).toBe(0);
});
test('boundary repeat with 65 distinct identities remains blocked despite native cursor',async({page})=>{
  await nativeShortWindowFixture(page,8,0,true,true);
  const r=await new DemandReader(page,90).collect();
  expect(r.complete).toBe(false);
  expect(r.aircraft.length).toBeLessThan(66);
  expect(r.warnings).toContain('PAGINATION_BOUNDARY_OVERLAP_NOT_RECONCILED');
  expect(await page.evaluate(()=>(window as any).pageAdvances)).toBe(3);
  expect(await page.evaluate(()=>(window as any).mutations)).toBe(0);
});
test('boundary repeat referring to a different aircraft is never reconciled',async({page})=>{
  await nativeShortWindowFixture(page,9,0,true,true,true);
  const r=await new DemandReader(page,90).collect();
  expect(r.complete).toBe(false);
  expect(r.aircraft.length).toBeLessThan(66);
  expect(r.warnings).toContain('PAGINATION_BOUNDARY_OVERLAP_NOT_RECONCILED');
  expect(await page.evaluate(()=>(window as any).mutations)).toBe(0);
});

test('real Routes(67): 20+20+19+7 is a valid native last page but must not authorize 66/67 routes',async({page})=>{
  await nativeShortWindowFixture(page,7,2,true,false,false,67);
  const result=await new DemandReader(page,80).collect();
  expect(result.complete).toBe(false);
  expect(result.expectedRoutes).toBe(67);
  expect(result.aircraft).toHaveLength(66);
  expect(new Set(result.aircraft.map(a=>a.routeId)).size).toBe(66);
  expect(result.warnings).toContain('ROUTE_COUNT_MISMATCH');
  expect(result.warnings).toContain('PAGINATION_NATIVE_OFFSET_GAP');
  expect(result.warnings).not.toContain('COLLECTION_REASON:PAGINATION_DUPLICATE');
  expect(await page.evaluate(()=>(window as any).pageAdvances)).toBe(3);
  expect(await page.evaluate(()=>(window as any).mutations)).toBe(0);
});
test('Routes(67) with last page containing the missing route can complete all 67 identities',async({page})=>{
  await nativeShortWindowFixture(page,8,2,true,false,false,67);
  const result=await new DemandReader(page,80).collect();
  expect(result.complete).toBe(true);
  expect(result.aircraft).toHaveLength(67);
  expect(new Set(result.aircraft.map(a=>a.routeId)).size).toBe(67);
  expect(new Set(result.aircraft.map(a=>a.aircraftId)).size).toBe(67);
  expect(await page.evaluate(()=>(window as any).mutations)).toBe(0);
});
test('Routes(67) with six cards in native last seven slots must still fail closed',async({page})=>{
  await nativeShortWindowFixture(page,6,2,true,false,false,67);
  const result=await new DemandReader(page,80).collect();
  expect(result.complete).toBe(false);
  expect(result.aircraft.length).toBeLessThan(67);
  expect(result.warnings).toContain('PAGINATION_OVERLAP_OR_INCOMPLETE');
  expect(await page.evaluate(()=>(window as any).mutations)).toBe(0);
});

test('reader matches inspected DOM, ignores ticket prices, reads remaining/total and next leg', async ({ page }) => {
  await fixture(page); const result = await new DemandReader(page, 400).collect();
  expect(result.complete).toBe(true); expect(result.aircraft).toHaveLength(2);
  expect(result.aircraft[0]).toMatchObject({ aircraftId: '1101', routeId: '101', capacity: { Y: 100, J: 0, F: 0 }, remaining: { Y: 90, J: 0, F: 0 }, dailyTotal: { Y: 1000, J: 200, F: 200 }, from: 'BBB', to: 'AAA', state: 'ready' });
  expect(Array.isArray(result.aircraft[0].currentRouteFieldDiagnostics)).toBe(true);
  expect(JSON.stringify(result.aircraft[0].currentRouteFieldDiagnostics)).toContain('route-name');
  expect(result.aircraft[1].state).toBe('inflight'); expect(result.aircraft[1].onboard).toEqual({Y:40,J:0,F:0}); expect(await page.evaluate(() => (window as any).mutations)).toBe(0);
});
test('visible cabin and demand panels tolerate stale hidden copies and surrounding labels', async ({ page }) => {
  await fixture(page);
  await page.evaluate(() => {
    const original=(window as any).show;
    (window as any).show=(id:number)=>{
      original(id);
      const d=document.getElementById('detailsAction')!;
      const staleSeats=d.querySelector('#seat-layout')!.cloneNode(true) as HTMLElement;
      staleSeats.removeAttribute('id'); staleSeats.style.display='none';
      const staleDemand=d.querySelector('#list-demand')!.cloneNode(true) as HTMLElement;
      staleDemand.removeAttribute('id'); staleDemand.style.display='none';
      d.append(staleSeats,staleDemand);
      d.querySelectorAll('#seat-layout > div').forEach((el,i)=>{
        const node=document.createTextNode(i===0?' Seats ':' Cabin ');
        el.insertBefore(node,el.firstChild);
      });
      d.querySelectorAll('#list-demand > div').forEach(el=>{
        el.insertBefore(document.createTextNode('Demand '),el.firstChild);
        el.appendChild(document.createTextNode(' passengers'));
      });
    };
  });
  const result=await new DemandReader(page,500).collect();
  expect(result.complete).toBe(true);
  expect(result.aircraft[0]).toMatchObject({
    state:'ready',capacity:{Y:100,J:0,F:0},remaining:{Y:90,J:0,F:0},dailyTotal:{Y:1000,J:200,F:200}
  });
});

test('pagination reads every page once', async ({ page }) => {
  await fixture(page, { pages: 2 }); const r = await new DemandReader(page, 400).collect(); expect(r.complete).toBe(true); expect(r.aircraft).toHaveLength(3);
});


test('inventory pagination finishes before opening any aircraft details',async({page})=>{
  await fixture(page,{pages:2});
  await page.evaluate(()=>{
    const w=window as any,show=w.show,render=w.render;
    w.inventoryOrder=[];
    w.show=(id:number)=>{w.inventoryOrder.push('details:'+id);show(id);};
    w.render=(index:number)=>{if(index===1)w.inventoryOrder.push('page:second');render(index);};
  });
  const result=await new DemandReader(page,500).collect();
  expect(result.complete).toBe(true);
  const order=await page.evaluate(()=>(window as any).inventoryOrder as string[]);
  expect(order[0]).toBe('page:second');
  expect(order.some(item=>item.startsWith('details:'))).toBe(true);
  expect(result.aircraft.map(a=>a.routeId)).toEqual(['101','102','103']);
  expect(await page.evaluate(()=>(window as any).mutations)).toBe(0);
});

test('a transient first Next click can be retried once without losing fleet identity',async ({page})=>{
  await fixture(page,{pages:2});
  await page.evaluate(()=>{
    const next=document.querySelector('#routesContainer .pagination a')!;
    const original=next.getAttribute('onclick')||'';
    next.setAttribute('onclick',"window.navClicks=(window.navClicks||0)+1;if(window.navClicks===1)return false;"+original);
  });
  const report=await new DemandReader(page,120).collect();
  expect(report.complete).toBe(true);
  expect(report.expectedRoutes).toBe(3);
  expect(report.aircraft.map(x=>x.routeId)).toEqual(['101','102','103']);
  expect(await page.evaluate(()=>(window as any).navClicks)).toBe(2);
  expect(await page.evaluate(()=>(window as any).mutations)).toBe(0);
});


test('asynchronous Next page waits for every unique visible row, not only first ID',async({page})=>{
  await fixture(page,{pages:2});
  await page.evaluate(()=>{
    const original=(window as any).render;
    (window as any).render=(index:number)=>{
      original(index);
      if(index!==1)return;
      const container=document.querySelector('#routesContainer')!;
      const stale=document.createElement('div');
      stale.id='routeMainList101';stale.className='row classPAX';
      stale.innerHTML='<span class="s-text">AAA - BBB</span>';
      container.prepend(stale);
      setTimeout(()=>stale.remove(),120);
    };
  });
  const report=await new DemandReader(page,500).collect();
  expect(report.complete).toBe(true);
  expect(report.aircraft.map(a=>a.routeId)).toEqual(['101','102','103']);
  expect(report.warnings).toEqual([]);
  expect(await page.evaluate(()=>(window as any).mutations)).toBe(0);
});


async function overlappingPageFixture(page:Page,permanent:boolean|number){
  await fixture(page,{pages:2});
  await page.evaluate((alwaysBad)=>{
    const w=window as any,render=w.render,ajax=w.Ajax;
    w.badPageAttempts=0;w.fleetReopens=0;
    w.render=(index:number)=>{
      render(index);
      if(index===0){
        document.querySelector('#routesContainer .pagination a')!
          .setAttribute('onclick',"Ajax('routes.php?start=20&sort=','routeAction',this);");
      }
      if(index!==1)return;
      w.badPageAttempts++;
      if(typeof alwaysBad==='number'?w.badPageAttempts<=alwaysBad:(alwaysBad||w.badPageAttempts===1)){
        const extra=document.createElement('div');extra.id='routeMainList101';
        extra.className='row classPAX';extra.innerHTML='<span class="s-text">AAA - BBB</span>';
        document.querySelector('#routesContainer')!.append(extra);
      }
    };
    w.Ajax=(url:string,...args:any[])=>{
      if(url==='routes.php'){
        w.fleetReopens++;
        const old=document.querySelector('#routesContainer')!;
        const fresh=document.createElement('div');fresh.id='routesContainer';
        old.replaceWith(fresh);w.render(0);return;
      }
      if(url==="routes.php?start=20&sort="){w.render(1);return;}
      return ajax(url,...args);
    };
    document.querySelector('#routesContainer .pagination a')!
      .setAttribute('onclick',"Ajax('routes.php?start=20&sort=','routeAction',this);");
    w.$=(selector:string)=>({
      removeClass(){return this;},addClass(){return this;},
      hide(){const el=document.querySelector(selector) as HTMLElement|null;
        if(el)el.style.display='none';return this;}
    });
    const button=document.querySelector('#popBtn1')!;
    button.setAttribute('onclick',"$('.popMenuBtn').removeClass('active');$(this).addClass('active');$('#detailsAction').hide();Ajax('routes.php','routeAction',this,false,false);");
    const menu=document.createElement('button');menu.id='mapRoutes';
    menu.textContent='Fleet main menu';
    menu.setAttribute('onclick',"hideAllWhenClick();menuFleet('Routes');");
    document.body.append(menu);
    w.reloadCount=0;
  },permanent);
  // Controlled stand-in for the authenticated document reload. All network
  // requests remain aborted; never access the game in offline unit tests.
  (page as any).reload=async()=>{
    await page.evaluate(()=>{
      const w=window as any;
      w.reloadCount++;
      w.render(0);
    });
    return null;
  };
}
test('late page overlap is recovered by replaying verified native Fleet pages',async({page})=>{
  await overlappingPageFixture(page,false);
  const result=await new DemandReader(page,500).collect();
  expect(result.complete).toBe(true);
  expect(result.aircraft.map(a=>a.routeId)).toEqual(['101','102','103']);
  expect(result.warnings).toEqual([]);
  expect(await page.evaluate(()=>(window as any).fleetReopens)).toBe(2);
  expect(await page.evaluate(()=>(window as any).mutations)).toBe(0);
});
test('permanent late page overlap stays incomplete after bounded verified replay',async({page})=>{
  await overlappingPageFixture(page,true);
  const result=await new DemandReader(page,300).collect();
  expect(result.complete).toBe(false);
  expect(result.aircraft.map(a=>a.routeId)).toEqual(['101','102']);
  expect(result.warnings).toContain('PAGINATION_OVERLAP_OR_INCOMPLETE');
  expect(result.warnings).toContain('PAGINATION_PAGE:1');
  expect(await page.evaluate(()=>(window as any).fleetReopens)).toBe(2);
  expect(await page.evaluate(()=>(window as any).reloadCount)).toBe(0);
  expect(await page.evaluate(()=>(window as any).mutations)).toBe(0);
});

test('clean fresh Fleet scan recovers if bounded page replay still failed',async({page})=>{
  // First complete attempt: initial Next and two bounded replays show overlapping
  // route IDs. The *new* scan must discard all prior snapshots and succeed.
  await overlappingPageFixture(page,3);
  const result=await collectFleetWithFreshRetry(page,120,true);
  expect(result.complete).toBe(true);
  expect(result.aircraft.map(a=>a.routeId)).toEqual(['101','102','103']);
  expect(result.warnings).toEqual([]);
  expect(await page.evaluate(()=>(window as any).fleetReopens)).toBe(4);
  expect(await page.evaluate(()=>(window as any).reloadCount)).toBe(1);
  expect(await page.evaluate(()=>(window as any).mutations)).toBe(0);
});
test('fresh Fleet retry remains blocked on persistent overlap',async({page})=>{
  await overlappingPageFixture(page,true);
  const result=await collectFleetWithFreshRetry(page,120,true);
  expect(result.complete).toBe(false);
  expect(result.warnings).toContain('FLEET_FRESH_RETRY_INCOMPLETE');
  expect(result.aircraft).toHaveLength(2);
  expect(await page.evaluate(()=>(window as any).fleetReopens)).toBe(5);
  expect(await page.evaluate(()=>(window as any).reloadCount)).toBe(1);
  expect(await page.evaluate(()=>(window as any).mutations)).toBe(0);
});
test('fresh Fleet retry is skipped without a conservative time budget',async({page})=>{
  await overlappingPageFixture(page,true);
  const result=await collectFleetWithFreshRetry(page,120,true,Date.now()+90000);
  expect(result.complete).toBe(false);
  expect(result.warnings).toContain('FLEET_FRESH_RETRY_BUDGET_INSUFFICIENT');
  expect(await page.evaluate(()=>(window as any).fleetReopens)).toBe(2);
  expect(await page.evaluate(()=>(window as any).mutations)).toBe(0);
});

test('native Fleet pagination is restored after opening aircraft details resets page cursor',async ({page})=>{
  await page.route('**/*',route=>route.abort());
  await page.setContent('<button>Routes (5)</button><button id="popBtn1">Fleet</button><div id="routeAction"><div id="routesContainer"></div></div><div id="detailsAction" style="display:none"></div>');
  await page.evaluate(()=>{
    const w=window as any;w.intro=0;w.mutations=0;w.listRestores=0;w.cursor=0;
    w.playSound=()=>{};
    w.$=(selector:string)=>({
      removeClass(){return this;},addClass(){return this;},
      hide(){const el=document.querySelector(selector) as HTMLElement|null;if(el)el.style.display='none';return this;}
    });
    w.render=(index:number)=>{
      w.cursor=index;
      const old=document.querySelector('#routesContainer')!;
      const container=document.createElement('div');container.id='routesContainer';old.replaceWith(container);
      (document.querySelector('#routeAction') as HTMLElement).style.display='block';
      const pages=[[101,102],[103,104],[105]];
      for(const id of pages[index]){
        const row=document.createElement('div');
        row.id='routeMainList'+id;row.className='row classPAX'+(id===104?' listDepartable':'');
        row.innerHTML='<span class="s-text">AAA - BBB</span>';
        const link=document.createElement('a');link.href='javascript:void(0)';
        link.setAttribute('onclick',"playSound('neutral_click');Ajax('fleet_details.php?id="+(id+1000)+"','detailsAction');if(intro==0){$('#routeAction').hide();}");
        link.innerHTML='<span id="acRegList'+(id+1000)+'">TEST-'+id+'</span> - Aircraft';
        row.append(link);
        if(id===104){const depart=document.createElement('button');depart.id='listDepart104';depart.textContent='Depart';row.append(depart);}
        container.append(row);
      }
      if(index<2){
        const ul=document.createElement('ul');ul.className='pagination';
        const link=document.createElement('a');link.href='javascript:void(0)';link.textContent='Next';
        link.setAttribute('onclick',"Ajax('routes.php?start="+((index+1)*20)+"&sort=','routeAction',this);");
        ul.append(link);container.append(ul);
      }
    };
    w.show=(id:number)=>{
      const details=document.querySelector('#detailsAction') as HTMLElement;
      details.style.display='block';
      details.innerHTML='<div id="route-name"><span class="glyphicons-chevron-left">Back</span></div>'+
        '<span id="ff-name">TEST-'+id+'</span>'+
        '<button id="routeViewDepart" onclick="window.mutations++; /* route_depart.php?id='+id+'&ref=list */">Depart</button>'+
        '<button id="routeViewGround_unground">Ground</button>'+
        '<div class="col-5"><span class="l-text">BBB</span></div><div class="col-5"><span class="l-text">AAA</span></div>'+
        '<div id="seat-layout">'+['economy','business','first'].map((c,i)=>'<div><img src="assets/'+c+'_seat.png"><br>'+(i?0:100)+'</div>').join('')+'</div>'+
        '<div id="list-demand">'+['economy','business','first'].map((c,i)=>'<div><img src="assets/'+c+'_seat.png"><br>'+(i?'0/200':'90/1000')+'</div>').join('')+'</div>';
      details.querySelector('.glyphicons-chevron-left')!.addEventListener('click',()=>{
        details.style.display='none';w.listRestores++;w.render(0);
      });
    };
    w.Ajax=(url:string)=>{
      if(url==='routes.php'){w.render(0);return;}
      if(url.startsWith('routes.php?start=')){w.render(Number(url.match(/start=(\d+)/)![1])/20);return;}
      if(url.startsWith('fleet_details.php?id=')){w.show(Number(url.match(/id=(\d+)/)![1])-1000);return;}
    };
    document.querySelector('#popBtn1')!.setAttribute('onclick',
      "$('.popMenuBtn').removeClass('active');$(this).addClass('active');$('#detailsAction').hide();Ajax('routes.php','routeAction',this,false,false);");
    w.render(0);
  });
  const report=await new DemandReader(page,500).collect();
  expect(report.complete).toBe(true);
  expect(report.aircraft.map(a=>a.routeId)).toEqual(['101','102','103','104','105']);
  expect(report.aircraft[3].state).toBe('ready');
  expect(report.warnings).toEqual([]);
  expect(await page.evaluate(()=>(window as any).listRestores)).toBe(1);
  expect(await page.evaluate(()=>(window as any).mutations)).toBe(0);
});

test('permanently stalled pagination stays incomplete with explicit safe evidence',async ({page})=>{
  await fixture(page,{pages:2,loop:true});
  const report=await new DemandReader(page,120).collect();
  expect(report.complete).toBe(false);
  expect(report.warnings).toContain('PAGINATION_STALLED');
  expect(report.warnings).toContain('ROUTE_COUNT:2/3');
  expect(report.aircraft).toHaveLength(2);
  expect(await page.evaluate(()=>(window as any).mutations)).toBe(0);
});

test('hidden rows from other AM4 pages are not treated as current-page fleet rows', async ({ page }) => {
  await fixture(page, { pages: 2 });
  await page.evaluate(() => {
    const container=document.querySelector('#routesContainer')!;
    const hidden=document.createElement('div');
    hidden.id='routeMainList103';
    hidden.className='row classPAX listDepartable';
    hidden.style.display='none';
    hidden.innerHTML='<span class="s-text">AAA - BBB</span><a href="#" onclick="playSound(\'neutral_click\');Ajax(\'fleet_details.php?id=1203\',\'detailsAction\');if(intro==0) {$(\'#routeAction\').hide();}"><span id="acRegList1203">TEST-103</span> - Test aircraft</a>Demand: 90 / 0 / 0 <button id="listDepart103">Depart</button>';
    container.appendChild(hidden);
  });
  const result=await new DemandReader(page,500).collect();
  expect(result.complete).toBe(true);
  expect(result.aircraft).toHaveLength(3);
  expect(result.aircraft.find(a=>a.routeId==='103')).toMatchObject({aircraftId:'1103',state:'ready'});
});

test('route lookup paginates past hidden rows already retained in the DOM', async ({ page }) => {
  await fixture(page, { pages: 2 });
  await page.evaluate(() => {
    const container=document.querySelector('#routesContainer')!;
    const hidden=document.createElement('div');
    hidden.id='routeMainList103';
    hidden.className='row classPAX listDepartable';
    hidden.style.display='none';
    hidden.innerHTML='<span class="s-text">AAA - BBB</span><a href="#"><span>TEST-103</span></a><button id="listDepart103">Depart</button>';
    container.appendChild(hidden);
    const next=document.querySelector('#routesContainer .pagination a')!;
    next.setAttribute('onclick',"Ajax('routes.php?start=20&sort=','routeAction',this);");
    const w=window as any,original=w.Ajax;
    w.Ajax=(url:string,...args:any[])=>url==='routes.php?start=20&sort='?w.render(1):original(url,...args);
  });
  await findFleetRoute(page,{routeId:'103'} as any,500);
  await expect(page.locator('#routeMainList103')).toBeVisible();
});
test('observed route count bounds pagination and ignores residual Next after all routes are collected', async ({ page }) => {
  await fixture(page, { pages: 2, staleNext: true });
  const r = await new DemandReader(page, 400).collect();
  expect(r.complete).toBe(true); expect(r.aircraft).toHaveLength(3); expect(r.warnings).not.toContain('PAGINATION_LIMIT');
});
test('route lookup rejects an unverified pagination control before extra navigation', async ({ page }) => {
  await fixture(page, { pages: 2, staleNext: true });
  await expect(findFleetRoute(page, { routeId: '999' } as any, 400)).rejects.toThrow('RESEARCH_PAGINATION_CONTROL_UNVERIFIED');
});
test('opening Fleet waits for a visible route instead of a hidden stale first DOM row', async ({page})=>{
  await page.route('**/*',route=>route.abort());
  await page.setContent(`
    <button id="mapRoutes" onclick="hideAllWhenClick();menuFleet('Routes');">Fleet</button>
    <script>
      function hideAllWhenClick(){}
      function menuFleet(){
        const routeAction=document.createElement('div');routeAction.id='routeAction';
        routeAction.innerHTML='<div id="routesContainer"><div id="routeMainList999" style="display:none"></div><div id="routeMainList101">visible</div></div>';
        document.body.appendChild(routeAction);
      }
    </script>
  `);
  await openFleetList(page,500);
  await expect(page.locator('#routeMainList101')).toBeVisible();
});

test('route page limit is derived only from validated observed totals', () => {
  expect(routePageLimit(34)).toBe(2); expect(routePageLimit(0)).toBe(1);
  expect(() => routePageLimit(-1)).toThrow('ROUTE_PAGE_LIMIT_INVALID');
});
for (const options of [{ missingCabin: true }, { badDemand: true }, { wrongIdentity: true }, { missingDetails: true }]) {
  test(`UI loading/structure error fails closed ${JSON.stringify(options)}`, async ({ page }) => {
    await fixture(page, options); const r = await new DemandReader(page, 400).collect();
    expect(r.aircraft[0].state).toBe('unavailable'); expect(r.warnings).toContain('DETAILS_UNAVAILABLE:101');
    expect(await page.evaluate(() => (window as any).mutations)).toBe(0);
  });
}
test('route count mismatch blocks simulated approval', async ({ page }) => {
  await fixture(page, { badCount: true });
  await expect(runDemandSimulation(page, readDemandConfig({}))).rejects.toThrow('Coleta incompleta');
  const report = JSON.parse(await readFile('test-results/demand/demand-report.json', 'utf8'));
  expect(report.summary.sufficient).toBe(0); expect(report.collectionComplete).toBe(false);
});
test('pagination loop fails closed instead of duplicate evaluation', async ({ page }) => {
  await fixture(page, { pages: 2, loop: true }); expect((await new DemandReader(page, 400).collect()).complete).toBe(false);
});
test('FleetUtils simulation never clicks departAll, individual Depart or Ground', async ({ page }) => {
  await fixture(page); const previous = process.env.ENABLE_DEMAND_MANAGER; process.env.ENABLE_DEMAND_MANAGER = 'true';
  try { await new FleetUtils(page).departPlanes(); } finally {
    if (previous === undefined) delete process.env.ENABLE_DEMAND_MANAGER; else process.env.ENABLE_DEMAND_MANAGER = previous;
  }
  expect(await page.evaluate(() => (window as any).mutations)).toBe(0);
  const report = JSON.parse(await readFile('test-results/demand/demand-report.json', 'utf8'));
  expect(report.summary).toMatchObject({ sufficient: 1, notReady: 1 });
});
test('total UI load failure returns an incomplete report', async ({ page }) => {
  await page.setContent('<p>Loading</p>'); const r = await new DemandReader(page, 100).collect();
  expect(r.complete).toBe(false); expect(r.warnings).toContain('COLLECTION_FAILED');
});


test('reads automatic fare reference without clicking Auto/Save or changing prices', async ({ page }) => {
  await fixture(page); const result = await new DemandReader(page, 400).collect();
  expect(result.aircraft[0].fares).toMatchObject({ automatic: { Y: 1234, J: 3456, F: 17890 }, current: { Y: 9999, J: 9999, F: 9999 }, source: 'inspected-auto-control' });
  expect(result.aircraft[0].fares?.controls).toEqual([
    {id:'',label:'Auto',tag:'BUTTON',type:null,onclickShape:'ticketPriceSuggest(#,#,#,this,#);'},
    {id:'',label:'Save',tag:'BUTTON',type:null,onclickShape:'window.mutations++'}
  ]);
  expect(result.aircraft[0].fares?.saveControl).toMatchObject({
    endpointVerified:false,target:'unavailable',targetMatchesContext:false
  });
  expect(await page.locator('#eTicket').inputValue()).toBe('9999');
  expect(await page.evaluate(() => (window as any).mutations)).toBe(0);
});
test('unknown Auto callback does not invalidate valid demand but blocks pricing', async ({ page }) => {
  await fixture(page, { unknownAuto: true }); const result = await new DemandReader(page, 400).collect();
  expect(result.aircraft[0].state).toBe('ready'); expect(result.aircraft[0].fares?.source).toBe('unavailable');
  expect(await page.evaluate(() => (window as any).mutations)).toBe(0);
});


test('operational observations reach both JSON reports without authorizing operations', async ({ page }) => {
  await fixture(page, { operational: true });
  await runDemandSimulation(page, readDemandConfig({}));
  const demand = JSON.parse(await readFile('test-results/demand/demand-report.json', 'utf8'));
  const optimization = JSON.parse(await readFile('test-results/demand/optimization-report.json', 'utf8'));
  expect(demand.decisions[0].operational).toMatchObject({rangeKm:3440,minRunwayFt:7550,cycles:206,homeBase:null,flightId:null});
  expect(optimization.aircraft[0].operational).toEqual(demand.decisions[0].operational);
  expect(optimization.aircraft[0].route.decision).toBe('unavailable');
  expect(await page.evaluate(()=>(window as any).mutations)).toBe(0);
});


test('optional inflight inspection reads capacity and operational data without authorizing departures', async ({ page }) => {
  await fixture(page, { operational: true });
  const result = await new DemandReader(page, 400, true).collect();
  expect(result.complete).toBe(true);
  expect(result.aircraft[1]).toMatchObject({ aircraftId: '1102', state: 'inflight', from: 'AAA', to: 'BBB',
    capacity: {Y:100,J:0,F:0}, operational: {rangeKm:3440,cycles:206,flightId:null,homeBase:null} });
  expect(result.aircraft[1].issue).toBeUndefined();
  expect(await page.evaluate(() => (window as any).mutations)).toBe(0);
});
test('targeted aircraft re-read validates ready and inflight state without scanning the fleet',async({page})=>{
 await fixture(page,{operational:true});
 const reader=new DemandReader(page,500,true),initial=await reader.collect();
 const ready=initial.aircraft.find(a=>a.aircraftId==='1101')!;
 const inflight=initial.aircraft.find(a=>a.aircraftId==='1102')!;
 const freshReady=await reader.readAircraftDetails(ready);
 expect(freshReady).toMatchObject({aircraftId:'1101',routeId:'101',state:'ready',capacity:{Y:100,J:0,F:0}});
 await page.locator('#route-name .glyphicons-chevron-left').click();
 await expect(page.locator('#routeAction')).toBeVisible();
 const freshInflight=await reader.readAircraftDetails(inflight);
 expect(freshInflight).toMatchObject({aircraftId:'1102',routeId:'102',state:'inflight',onboard:{Y:40,J:0,F:0}});
 expect(freshInflight.timing?.source).toBe('inspected-flight-countdown');
 expect(await page.evaluate(()=>(window as any).mutations)).toBe(0);
});

test('unknown aircraft link callback is rejected before a click',async({page})=>{
 await fixture(page);await page.locator('#routeMainList101 a').evaluate(e=>e.setAttribute('onclick','window.mutations++'));
 const r=await new DemandReader(page,400).collect();expect(r.aircraft[0].state).toBe('unavailable');
 expect(r.warnings).toContain('DETAILS_UNAVAILABLE:101');expect(await page.evaluate(()=>(window as any).mutations)).toBe(0);
});

test('bare inflight link supplies ID through the confirmed callback and registration through details',async({page})=>{
 await fixture(page,{operational:true});await page.locator('#routeMainList102 a').evaluate(e=>e.textContent='TEST-102 - Test aircraft');
 const r=await new DemandReader(page,500,true).collect();expect(r.complete).toBe(true);
 expect(r.aircraft[1]).toMatchObject({aircraftId:'1102',registration:'TEST-102',state:'inflight',capacity:{Y:100,J:0,F:0},remaining:{Y:90,J:0,F:0}});
 expect(r.warnings).toEqual([]);expect(await page.evaluate(()=>(window as any).mutations)).toBe(0);
});
test('card ID conflicting with callback is blocked without clicking',async({page})=>{
 await fixture(page);await page.locator('#acRegList1101').evaluate(e=>e.id='acRegList9999');
 const r=await new DemandReader(page,400,true).collect();expect(r.aircraft[0].state).toBe('unavailable');expect(await page.evaluate(()=>(window as any).mutations)).toBe(0);
});
test('multiple aircraft callbacks on a card cannot select an arbitrary identity',async({page})=>{
 await fixture(page);await page.locator('#routeMainList101 a').evaluate(e=>e.after(e.cloneNode(true)));
 const r=await new DemandReader(page,400,true).collect();expect(r.aircraft[0].state).toBe('unavailable');expect(await page.evaluate(()=>(window as any).mutations)).toBe(0);
});
