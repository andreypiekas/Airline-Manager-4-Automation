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
  'WAIT_CONTAINER_VISIBLE','WAIT_ROUTE_CARDS_VISIBLE','VERIFY_QUOTE_CLOSED'
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
