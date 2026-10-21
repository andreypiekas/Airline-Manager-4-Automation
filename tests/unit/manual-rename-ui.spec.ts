import {test,expect} from '@playwright/test';
import {renameNativePrompt} from '../../fleet-rename/run';
import type {RenameTarget} from '../../fleet-rename/plan';

const target:RenameTarget={
 aircraftId:'2',routeId:'98',oldAircraftRegistration:'OLD-2',
 oldRouteLabel:'AAA - GRU',aircraftRegistration:'XP-001',routeRegistration:'XR-001'
};
async function synthetic(page:import('@playwright/test').Page,callback:string){
 const requests:string[]=[];
 await page.route('https://www.airlinemanager.com/**',async route=>{
  if(route.request().url().includes('mode='))requests.push(route.request().url());
  await route.fulfill({status:200,body:'ok'});
 });
 await page.goto('https://www.airlinemanager.com/synthetic');
 await page.setContent(`<div id="detailsAction">
 <button id="editor" onclick="${callback.replaceAll('"','&quot;')}">Rename</button>
 </div><script>function Ajax(url){return fetch(url)}</script>`);
 return requests;
}
test('native aircraft prompt waits for verified AJAX request and stores click intent first',async({page})=>{
 const requests=await synthetic(page,"Ajax('fleet_details.php?id=2&mode=reg&reg='+prompt('Rename aircraft'),'detailsAction');");
 const order:string[]=[];
 await renameNativePrompt(page,page.locator('#detailsAction'),target,'aircraft','XP-001',async()=>{order.push('intent');},1800);
 expect(order).toEqual(['intent']);
 expect(requests).toHaveLength(1);
 const params=new URL(requests[0]).searchParams;
 expect(params.get('id')).toBe('2');
 expect(params.get('mode')).toBe('reg');
 expect(params.get('reg')).toBe('XP-001');
});
test('native route prompt sends the route ID, never the aircraft ID',async({page})=>{
 const requests=await synthetic(page,"Ajax('fleet_details.php?id=98&mode=routeReg&reg='+prompt('Rename route'),'detailsAction');");
 await renameNativePrompt(page,page.locator('#detailsAction'),target,'route','XR-001',async()=>{},1800);
 expect(requests).toHaveLength(1);
 expect(new URL(requests[0]).searchParams.get('id')).toBe('98');
 expect(new URL(requests[0]).searchParams.get('reg')).toBe('XR-001');
});
test('unverified native callback never clicks editor or sends any mutation request',async({page})=>{
 const requests=await synthetic(page,"wrongFunction('fleet_details.php?id=2&mode=reg&')");
 await expect(renameNativePrompt(page,page.locator('#detailsAction'),target,'aircraft','XP-001',async()=>{},700))
  .rejects.toThrow('RENAME_PROMPT_CONTROL_UNVERIFIED');
 expect(requests).toHaveLength(0);
});
