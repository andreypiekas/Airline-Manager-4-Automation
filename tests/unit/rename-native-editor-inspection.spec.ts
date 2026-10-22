import {test,expect,type Page} from '@playwright/test';
import {inspectNativeRenameEditors,sanitizedRenameCallbackShape} from '../../fleet-rename/run';
import {readFile} from 'node:fs/promises';

async function fixture(page:Page,unsafeAircraft=false,wrongRoute=false,hiddenEditors=false){
 const first=unsafeAircraft
  ?"Ajax('fleet_details.php?id=1001&mode=reg&reg='+prompt('Sensitive Aircraft','old-name'),'detailsAction');"
  :"Ajax('fleet_details.php?id=1001&mode=reg&reg='+prompt('Sensitive Aircraft'),'detailsAction');";
 const second="Ajax('fleet_details.php?id=101&mode=routeReg&reg='+prompt('Sensitive Route'),'detailsAction');";
 const nativeButtons='<button id="reg" onclick="'+first+'">Aircraft rename</button>'+
  '<button id="routeReg" onclick="'+second+'">Route rename</button>';
 const detailHtml='<div id="ff-name">N-1</div>'+
  '<div class="col-5"><span class="l-text">'+(wrongRoute?'CCC':'AAA')+'</span><span class="l-text">GRU</span></div>'+
  (hiddenEditors?'<div style="display:none">'+nativeButtons+'</div>':nativeButtons);
 await page.setContent(`<button>Routes (1)</button>
  <div id="routesContainer"><div id="routeMainList101">
   <span class="s-text">AAA - GRU</span>
   <a id="openPlane">N-1 - Aircraft</a>
  </div></div>
  <div id="detailsAction" style="display:none"></div>
  <script>
  window.detailsClicks=0;window.renameRequests=0;
  const intro=0;
  function playSound(){}
  function $(s){return {hide(){}}}
  function Ajax(url){
   if(url==='fleet_details.php?id=1001'){
    window.detailsClicks++;
    const d=document.getElementById('detailsAction');
    d.innerHTML=${JSON.stringify(detailHtml)};
    d.style.display='block';
   }else{window.renameRequests++;}
  }
  </script>`);
 await page.locator('#openPlane').evaluate(e=>e.setAttribute('onclick',
  "playSound('neutral_click');Ajax('fleet_details.php?id=1001','detailsAction');if(intro==0){$('#routeAction').hide();}"));
}
test('read-only inspection identifies both native editors without changing any names',async({page})=>{
 await fixture(page);
 const data=await inspectNativeRenameEditors(page,1500);
 expect(data.readOnly).toBe(true);expect(data.inspected).toBe(1);
 expect(data.routeCount).toBe(1);expect(data.allVerified).toBe(true);
 expect(data.editors).toMatchObject([
  {field:'aircraft',candidateCount:1,visible:true,enabled:true,callbackVerified:true},
  {field:'route',candidateCount:1,visible:true,enabled:true,callbackVerified:true}
 ]);
 expect(JSON.stringify(data)).not.toContain('Sensitive');
 expect(JSON.stringify(data)).not.toContain('1001');
 expect(await page.evaluate(()=>(window as any).detailsClicks)).toBe(1);
 expect(await page.evaluate(()=>(window as any).renameRequests)).toBe(0);
});
test('read-only inspection explains hidden ancestors and never clicks either editor',async({page})=>{
 await fixture(page,false,false,true);
 const data=await inspectNativeRenameEditors(page,1500);
 expect(data.allVerified).toBe(false);
 expect(data.editors).toMatchObject([
  {field:'aircraft',candidateCount:1,visible:false,enabled:true,
   callbackVerified:false,layoutCause:'ANCESTOR_DISPLAY_NONE',hiddenAncestorDepth:1},
  {field:'route',candidateCount:1,visible:false,enabled:true,
   callbackVerified:false,layoutCause:'ANCESTOR_DISPLAY_NONE',hiddenAncestorDepth:1}
 ]);
 expect(JSON.stringify(data)).not.toContain('Sensitive');
 expect(await page.evaluate(()=>(window as any).renameRequests)).toBe(0);
});
test('unverified two-argument prompt is detected and redacted; no editor is clicked',async({page})=>{
 await fixture(page,true);
 const result=await inspectNativeRenameEditors(page,1500);
 expect(result.allVerified).toBe(false);
 expect(result.editors[0].callbackVerified).toBe(false);
 expect(result.editors[1].callbackVerified).toBe(true);
 expect(result.editors[0].callbackShape).not.toContain('Sensitive');
 expect(result.editors[0].callbackShape).toContain('prompt');
 expect(result.editors[0].callbackShape).not.toContain('old-name');
 expect(await page.evaluate(()=>(window as any).renameRequests)).toBe(0);
});
test('an editor is not inspected when native route airports do not match',async({page})=>{
 await fixture(page,false,true);
 await expect(inspectNativeRenameEditors(page,1500))
  .rejects.toThrow('RENAME_DETAILS_ROUTE_ENDPOINTS_UNVERIFIED');
 expect(await page.evaluate(()=>(window as any).renameRequests)).toBe(0);
});
test('sanitized callback structure never persists user names or endpoint IDs',()=>{
 const raw="Ajax('fleet_details.php?id=123&mode=reg&reg='+prompt('Secret Name','Current Name'),'detailsAction');";
 const safe=sanitizedRenameCallbackShape(raw);
 expect(safe).toContain('prompt');expect(safe).toContain('Ajax');
 for(const forbidden of ['123','Secret Name','Current Name','fleet_details.php'])
  expect(safe).not.toContain(forbidden);
});
test('sanitized callback explains safe native helper functions, not their arguments',()=>{
 const raw="playSound('neutral_click');Ajax('fleet_details.php?id=123&mode=reg&reg='+"+
  "encodeURIComponent(prompt('Private name').trim()),'detailsAction',this);";
 const safe=sanitizedRenameCallbackShape(raw);
 expect(safe).toBe('playSound(Q);Ajax(Q+encodeURIComponent(prompt(Q).trim()),Q,this);');
 for(const forbidden of ['123','Private name','fleet_details.php','detailsAction','neutral_click'])
  expect(safe).not.toContain(forbidden);
});
test('manual workflow contains inspect as explicit operation, never as scheduled job',async()=>{
 const file=await readFile('.github/workflows/manual-fleet-rename.yml','utf8');
 expect(file).toContain('options: [preview, inspect, apply]');
 expect(file).toContain("github.event_name == 'workflow_dispatch'");
 expect(file).not.toMatch(/cron:|schedule:/);
});
