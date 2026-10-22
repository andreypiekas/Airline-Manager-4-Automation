import {test,expect,type Page} from '@playwright/test';
import {authorizeSingleAircraftPilot,type RenamePlan,type RenameTarget} from '../../fleet-rename/plan';
import {nativeTextSaveQueryKey,preflightNativeTextEditors,saveNativeTextField} from '../../fleet-rename/native-pilot';
import {readFile} from 'node:fs/promises';

const target:RenameTarget={
 aircraftId:'1001',routeId:'101',oldAircraftRegistration:'OLD-PLANE',
 oldRouteLabel:'AAA - GRU',aircraftRegistration:'XP-001',routeRegistration:'XR-001'
};
const plan:RenamePlan={schemaVersion:1,count:2,digest:'a'.repeat(64),
 targets:[target,{...target,aircraftId:'1002',routeId:'102',
  aircraftRegistration:'XP-002',routeRegistration:'XR-002'}]};
test('pilot requires explicit aircraftId, full preview hash and different confirmation',()=>{
 expect(authorizeSingleAircraftPilot(plan,'1001',plan.digest,'APLICAR_PILOTO_UMA_AERONAVE')).toEqual(target);
 for(const args of [
  ['','a'.repeat(64),'APLICAR_PILOTO_UMA_AERONAVE'],
  ['1003',plan.digest,'APLICAR_PILOTO_UMA_AERONAVE'],
  ['1001','b'.repeat(64),'APLICAR_PILOTO_UMA_AERONAVE'],
  ['1001',plan.digest,'APLICAR_RENOMEACAO_TOTAL']
 ]){
  expect(()=>authorizeSingleAircraftPilot(plan,...args as [string,string,string])).toThrow();
 }
});
test('only exact native Ajax text handlers are accepted for selected field',()=>{
 const native="playSound('neutral_click');Ajax('fleet_details.php?id=1001&mode=reg&reg='+$('#regInput').val(),'detailsAction',this);";
 expect(nativeTextSaveQueryKey(native,'1001','reg','regInput')).toBe('reg');
 for(const changed of [
  native.replace('id=1001','id=1002'),native.replace('mode=reg','mode=routeReg'),
  native.replace("$('#regInput').val()","prompt('name')"),
  native.replace("$('#regInput').val()","$('#another').val()"),
  native.replace(",'detailsAction',this);",",'detailsAction');"),
  native+"alert('oops');",
  native.replace("&reg=","&id=")
 ])expect(nativeTextSaveQueryKey(changed,'1001','reg','regInput')).toBeNull();
});
async function fixture(page:Page,brokenRoute=false){
 await page.route('https://www.airlinemanager.com/test-pilot',route=>
  route.fulfill({status:200,contentType:'text/html',body:'<html><body></body></html>'}));
 await page.goto('https://www.airlinemanager.com/test-pilot');
 await page.setContent(
  '<div id="detailsAction">'+
  '<span id="badgeA">open aircraft</span><span id="badgeR">open route</span>'+
  '<div id="panelA" style="display:none"><div><span>'+
   '<input type="text" id="regInput" value="OLD-PLANE"><button id="saveA">Save aircraft</button>'+
  '</span></div></div>'+
  '<div id="panelR" style="display:none"><div><span>'+
   '<input type="text" id="rtInput" value="OLD-ROUTE"><button id="saveR">Save route</button>'+
  '</span></div></div></div>');
 await page.addScriptTag({content:[
  'window.gameSaves=[];',
  'function playSound(){}',
  'function $(selector){ const el=document.querySelector(selector);',
  "return {hide(){el.style.display='none';},show(){el.style.display='block';},val(){return el.value;}};}",
  'function Ajax(url){window.gameSaves.push(url);fetch("/"+url);}'
 ].join('\n')});
 await page.locator('#badgeA').evaluate(e=>e.setAttribute('onclick',
  "$('#badgeA').hide();$('#panelA').show();playSound('neutral_click');"));
 await page.locator('#badgeR').evaluate(e=>e.setAttribute('onclick',
  "$('#badgeR').hide();$('#panelR').show();"));
 await page.locator('#saveA').evaluate(e=>e.setAttribute('onclick',
  "playSound('neutral_click');Ajax('fleet_details.php?id=1001&mode=reg&reg='+$('#regInput').val(),'detailsAction',this);"));
 await page.locator('#saveR').evaluate((e,broken)=>e.setAttribute('onclick',
  broken?"alert('not native')":
  "playSound('neutral_click');Ajax('fleet_details.php?id=101&mode=routeReg&reg='+$('#rtInput').val(),'detailsAction',this);"),brokenRoute);
}
test('preflight checks both editors without opening inputs or mutating',async({page})=>{
 await fixture(page);
 const editors=await preflightNativeTextEditors(page.locator('#detailsAction'),target);
 expect(editors).toHaveLength(2);
 expect(editors.map(e=>e.queryKey)).toEqual(['reg','reg']);
 expect(await page.locator('#saveA').isVisible()).toBe(false);
 expect(await page.locator('#saveR').isVisible()).toBe(false);
 expect(await page.evaluate(()=>(window as any).gameSaves)).toEqual([]);
});
test('preflight rejects mismatched second editor before first edit',async({page})=>{
 await fixture(page,true);
 await expect(preflightNativeTextEditors(page.locator('#detailsAction'),target))
  .rejects.toThrow('RENAME_PILOT_EDITOR_AMBIGUOUS');
 expect(await page.locator('#panelA').isVisible()).toBe(false);
 expect(await page.evaluate(()=>(window as any).gameSaves)).toEqual([]);
});
test('one native click saves exactly one field only after checkpoint',async({page})=>{
 await fixture(page);
 const saves:string[]=[];
 await page.route('https://www.airlinemanager.com/fleet_details.php?*',async route=>{
  saves.push(route.request().url());
  await route.fulfill({status:200,contentType:'text/html',body:'OK'});
 });
 const editors=await preflightNativeTextEditors(page.locator('#detailsAction'),target);
 let checkpointed=false;
 await saveNativeTextField(page,editors[0],'XP-001',async()=>{
  expect(await page.evaluate(()=>(window as any).gameSaves)).toEqual([]);
  checkpointed=true;
 },2500);
 expect(checkpointed).toBe(true);
 expect(saves).toHaveLength(1);
 expect(new URL(saves[0]).searchParams.get('id')).toBe('1001');
 expect(new URL(saves[0]).searchParams.get('mode')).toBe('reg');
 expect(new URL(saves[0]).searchParams.get('reg')).toBe('XP-001');
 expect(await page.locator('#saveR').isVisible()).toBe(false);
});
test('pilot is manual; full-fleet apply remains disabled',async()=>{
 const flow=await readFile('.github/workflows/manual-fleet-rename.yml','utf8');
 const script=await readFile('fleet-rename/run.ts','utf8');
 expect(flow).toContain('options: [preview, inspect, inspect-open, pilot, apply]');
 expect(flow).toContain('RENAME_PILOT_AIRCRAFT_ID:');
 expect(flow).not.toMatch(/cron:|schedule:/);
 expect(script).toContain("if(operation==='apply')throw Error('RENAME_BULK_REQUIRES_VALIDATED_PILOT')");
 expect(script).toContain("if(operation==='pilot')");
});
