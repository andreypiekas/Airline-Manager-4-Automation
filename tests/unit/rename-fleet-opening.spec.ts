import {test,expect,type Page} from '@playwright/test';
import {openFleetList,type FleetOpenStage} from '../../demand/navigation';

async function mockFleet(page:Page,reusesContainer:boolean){
 await page.setContent(`<button id="mapRoutes" onclick="hideAllWhenClick();menuFleet('Routes');">Fleet</button>
 <div id="routesContainer" style="display:none"><div id="routeMainList555" style="display:none"></div></div>
 <script>
 window.mutationCalls=0;
 function hideAllWhenClick(){}
 function menuFleet(){
  const prior=document.getElementById('routesContainer');
  if(!${reusesContainer}) prior.remove();
  const next=${reusesContainer} ? prior : document.createElement('div');
  next.id='routesContainer';next.style.display='block';
  next.innerHTML='<div id="routeMainList101">Synthetic route</div>';
  if(!${reusesContainer}) document.body.appendChild(next);
 }
 </script>`);
}
test('Fleet native reopening records safe read-only stages on replaced container',async({page})=>{
 await mockFleet(page,false);
 const stages:FleetOpenStage[]=[];
 await openFleetList(page,1200,stage=>stages.push(stage));
 expect(stages).toEqual([
  'INSPECT_CONTROL','CLICK_CONTROL','WAIT_OLD_CONTAINER_DETACH',
  'WAIT_CONTAINER_VISIBLE','WAIT_ROUTE_CARDS_VISIBLE','WAIT_NATIVE_FRAGMENT_LOADER_CLEAR','VERIFY_QUOTE_CLOSED'
 ]);
 expect(await page.locator('#routeMainList101').isVisible()).toBe(true);
 expect(await page.evaluate(()=>(window as any).mutationCalls)).toBe(0);
});
test('in-place DOM reuse fails closed and pinpoints the exact wait',async({page})=>{
 await mockFleet(page,true);
 const stages:FleetOpenStage[]=[];
 await expect(openFleetList(page,250,stage=>stages.push(stage))).rejects.toThrow();
 expect(stages.at(-1)).toBe('WAIT_OLD_CONTAINER_DETACH');
 expect(await page.evaluate(()=>(window as any).mutationCalls)).toBe(0);
});

test('native AJAX loader must disappear before Fleet is accepted, even if cards exist',async({page})=>{
 await page.setContent(`<button id="mapRoutes" onclick="hideAllWhenClick();menuFleet('Routes');">Fleet</button>
 <script>
 window.departures=0;window.hadLoader=false;
 function hideAllWhenClick(){}
 function menuFleet(){
   const container=document.createElement('div');container.id='routesContainer';
   container.innerHTML='<div id="routeMainList101">Visible but not ready</div><img id="loading" src="loader.gif" alt="loading">';
   document.body.appendChild(container);
   setTimeout(()=>{
     window.hadLoader=!!document.querySelector('#routesContainer #loading');
     document.getElementById('loading').remove();
   },120);
 }
 </script>`);
 const stages:FleetOpenStage[]=[];
 await openFleetList(page,2000,stage=>stages.push(stage));
 expect(stages).toContain('WAIT_NATIVE_FRAGMENT_LOADER_CLEAR');
 expect(stages.at(-1)).toBe('VERIFY_QUOTE_CLOSED');
 expect(await page.evaluate(()=>(window as any).hadLoader)).toBe(true);
 expect(await page.locator('#routesContainer #loading').count()).toBe(0);
 expect(await page.evaluate(()=>(window as any).departures)).toBe(0);
});

test('stuck native loader fails closed and does not click Depart',async({page})=>{
 await page.setContent(`<button id="mapRoutes" onclick="hideAllWhenClick();menuFleet('Routes');">Fleet</button>
 <script>
 window.departures=0;
 function hideAllWhenClick(){}
 function menuFleet(){
   const container=document.createElement('div');container.id='routesContainer';
   container.innerHTML='<div id="routeMainList101">Stale card <button onclick="window.departures++">Depart</button></div><img src="loader.gif" alt="loading">';
   document.body.appendChild(container);
 }
 </script>`);
 const stages:FleetOpenStage[]=[];
 await expect(openFleetList(page,300,stage=>stages.push(stage))).rejects.toThrow();
 expect(stages.at(-1)).toBe('WAIT_NATIVE_FRAGMENT_LOADER_CLEAR');
 expect(await page.evaluate(()=>(window as any).departures)).toBe(0);
});
