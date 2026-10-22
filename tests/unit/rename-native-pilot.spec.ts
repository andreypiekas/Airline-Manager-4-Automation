import {test,expect,type Page} from '@playwright/test';
import {authorizeSingleAircraftPilot,selectSingleAircraftPilotTarget,type RenamePlan,type RenameTarget} from '../../fleet-rename/plan';
import {nativeTextSaveQueryKey,preflightNativeTextEditors,saveNativeTextField,diagnoseNativeTextInputs,type NativeInputDiagnostic} from '../../fleet-rename/native-pilot';
import {readFile} from 'node:fs/promises';
import {runManualFleetRename,verifiedReadOnlyNativeOpener} from '../../fleet-rename/run';

const target:RenameTarget={
 aircraftId:'1001',routeId:'101',oldAircraftRegistration:'OLD-PLANE',
 oldRouteLabel:'AAA - GRU',aircraftRegistration:'XP-001',routeRegistration:'XR-001'
};
const plan:RenamePlan={schemaVersion:1,count:2,digest:'a'.repeat(64),
 targets:[target,{...target,aircraftId:'1002',routeId:'102',
  aircraftRegistration:'XP-002',routeRegistration:'XR-002'}]};
test('pilot requires explicit aircraftId, full preview hash and different confirmation',()=>{
 expect(authorizeSingleAircraftPilot(plan,'1001',plan.digest,'APLICAR_PILOTO_UMA_AERONAVE')).toEqual(target);
 expect(selectSingleAircraftPilotTarget(plan,'1001',plan.digest)).toEqual(target);
 expect(()=>selectSingleAircraftPilotTarget(plan,'1001','b'.repeat(64))).toThrow();
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
async function fixture(page:Page,brokenRoute=false,implicitText=false){
 await page.route('https://www.airlinemanager.com/test-pilot',route=>
  route.fulfill({status:200,contentType:'text/html',body:'<html><body></body></html>'}));
 await page.goto('https://www.airlinemanager.com/test-pilot');
 await page.setContent(
  '<div id="detailsAction">'+
  '<span id="badgeA">open aircraft</span><span id="badgeR">open route</span>'+
  '<div id="panelA" style="display:none"><div><span>'+
   '<input '+(implicitText?'':'type="text" ')+'id="regInput" maxlength="12" value="OLD-PLANE"><button id="saveA">Save aircraft</button>'+
  '</span></div></div>'+
  '<div id="panelR" style="display:none"><div><span>'+
   '<input '+(implicitText?'':'type="text" ')+'id="rtInput" maxlength="12" value="OLD-ROUTE"><button id="saveR">Save route</button>'+
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
test('implicit text inputs and short maxlength are accepted without mutation',async({page})=>{
 await fixture(page,false,true);
 const phases:string[]=[];
 const editors=await preflightNativeTextEditors(page.locator('#detailsAction'),target,
  phase=>phases.push(phase));
 expect(editors).toHaveLength(2);
 expect(phases).toEqual([
  'PILOT_PREFLIGHT_AIRCRAFT_FIND_CONTROL','PILOT_PREFLIGHT_AIRCRAFT_FIND_PANEL',
  'PILOT_PREFLIGHT_AIRCRAFT_FIND_INPUT','PILOT_PREFLIGHT_AIRCRAFT_FIND_OPENER',
  'PILOT_PREFLIGHT_ROUTE_FIND_CONTROL','PILOT_PREFLIGHT_ROUTE_FIND_PANEL',
  'PILOT_PREFLIGHT_ROUTE_FIND_INPUT','PILOT_PREFLIGHT_ROUTE_FIND_OPENER'
 ]);
 expect(await page.locator('#panelA').isVisible()).toBe(false);
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
 expect(flow).toContain('options: [preview, inspect, inspect-open, pilot-check, pilot, apply]');
 expect(flow).toContain('RENAME_PILOT_AIRCRAFT_ID:');
 expect(flow).not.toMatch(/cron:|schedule:/);
 expect(script).toContain("if(operation==='apply')throw Error('RENAME_BULK_REQUIRES_VALIDATED_PILOT')");
 expect(script).toContain("if(operation==='pilot'||operation==='pilot-check')");
 expect(script).toContain("if(operation==='pilot-check'){");
 expect(script.indexOf("if(operation==='pilot-check'){"))
  .toBeLessThan(script.indexOf("const marker=await open(join(directory"));
});

test('native target-details errors retain stage markers and never trigger an implicit retry',async()=>{
 const file=await readFile('fleet-rename/run.ts','utf8');
 const detailStart=file.indexOf('async function inspectTarget(');
 const detailEnd=file.indexOf('/** A supported game UI',detailStart);
 const targetPath=file.slice(detailStart,detailEnd);
 const stages=[
  'PILOT_TARGET_VERIFY_NO_CHALLENGE','PILOT_TARGET_REOPEN_FLEET',
  'PILOT_TARGET_FIND_ROUTE','PILOT_TARGET_VERIFY_ROW',
  'PILOT_TARGET_VERIFY_REGISTRATION','PILOT_TARGET_VERIFY_DETAILS_LINK',
  'PILOT_TARGET_CLICK_DETAILS_LINK','PILOT_TARGET_WAIT_DETAILS_VISIBLE',
  'PILOT_TARGET_VERIFY_DETAILS_CONTENT'
 ];
 expect(stages.every(marker=>targetPath.includes("onStage('"+marker+"')"))).toBe(true);
 expect(targetPath).not.toMatch(/\.fill\(|saveNativeTextField\(|renameNativePrompt\(/);
 expect(file).toContain("await inspectTarget(page,pilotTarget,pilotTarget.oldAircraftRegistration,timeout,markStage)");
 expect(file).toContain("report.stage.startsWith('PILOT_TARGET_')");
 expect(file).toContain("if(operation==='apply')throw Error('RENAME_BULK_REQUIRES_VALIDATED_PILOT')");
});

test('manual pilot loads its native editors statically before touching the real game',async()=>{
 const source=await readFile('fleet-rename/run.ts','utf8');
 expect(source).toMatch(/import \\{preflightNativeTextEditors,saveNativeTextField,verifiedReadOnlyNativeOpener(?:,type NativeInputDiagnostic)?\\} from '\\.\\/native-pilot';/);
 expect(source).not.toContain("await import('./native-pilot')");
 const editorSource=await readFile('fleet-rename/native-pilot.ts','utf8');
 expect(editorSource).toContain("import type {RenamePhase} from './run';");
 expect(editorSource).not.toContain("import {verifiedReadOnlyNativeOpener,type RenamePhase} from './run';");
 expect(editorSource).toContain('export function verifiedReadOnlyNativeOpener(');
 expect(source).toContain('export {verifiedReadOnlyNativeOpener};');
 expect(source).toContain("markStage('PILOT_PREFLIGHT_NATIVE_MODULE_READY')");
 // This test imports the native editor and manual workflow entrypoint together.
 // It must resolve their circular references in Playwright's actual TS loader.
 expect(typeof runManualFleetRename).toBe('function');
 expect(typeof preflightNativeTextEditors).toBe('function');
 expect(typeof saveNativeTextField).toBe('function');
 expect(verifiedReadOnlyNativeOpener(
  "$('#open').hide();$('#panelA').show();",'panelA')).toBe(true);
 // A read-only probe never enables full-fleet apply.
 expect(source).toContain("if(operation==='apply')throw Error('RENAME_BULK_REQUIRES_VALIDATED_PILOT')");
 expect(source).toContain("if(operation==='pilot-check'){");
});

test('read-only input diagnosis distinguishes unsupported Save grammar from missing input',()=>{
 const exact="playSound('neutral_click');Ajax('fleet_details.php?id=1001&mode=reg&reg='+$('#regInput').val(),'detailsAction',this);";
 const normal=diagnoseNativeTextInputs(exact,'1001','reg',['regInput'],'aircraft');
 expect(normal.matching).toEqual([0]);
 expect(normal.diagnostic).toMatchObject({
  inputCount:1,textInputCount:1,valueReferencedInputCount:1,
  strictNativeMatchCount:1,classification:'MATCHED'
 });
 // A structurally different callback never authorizes a Save click even
 // when the native jQuery input reference is present.
 const unsupported=exact.replace("playSound('neutral_click');",'');
 const result=diagnoseNativeTextInputs(unsupported,'1001','reg',['regInput'],'aircraft');
 expect(result.matching).toEqual([]);
 expect(result.diagnostic).toMatchObject({
  textInputCount:1,valueReferencedInputCount:1,
  strictNativeMatchCount:0,classification:'SAVE_HANDLER_SYNTAX_UNSUPPORTED'
 });
 expect(nativeTextSaveQueryKey(unsupported,'1001','reg','regInput')).toBeNull();
 expect(diagnoseNativeTextInputs(exact,'1001','reg',['other'],'aircraft')
  .diagnostic.classification).toBe('NO_VALUE_REFERENCE');
 expect(diagnoseNativeTextInputs(exact,'1001','reg',[''],'aircraft')
  .diagnostic.classification).toBe('NO_TEXT_INPUT');
 expect(diagnoseNativeTextInputs(exact,'1001','reg',['regInput','regInput'],'aircraft')
  .diagnostic.classification).toBe('AMBIGUOUS');
});
test('preflight records safe input evidence without saving or logging raw ids',async({page})=>{
 await fixture(page);
 const notes:NativeInputDiagnostic[]=[];
 await preflightNativeTextEditors(page.locator('#detailsAction'),target,()=>{},d=>notes.push(d));
 expect(notes).toHaveLength(2);
 expect(notes.map(d=>d.classification)).toEqual(['MATCHED','MATCHED']);
 expect(JSON.stringify(notes)).not.toContain('regInput');
 expect(JSON.stringify(notes)).not.toContain('rtInput');
 expect(JSON.stringify(notes)).not.toContain('1001');
 expect(await page.evaluate(()=>(window as any).gameSaves)).toEqual([]);
});
