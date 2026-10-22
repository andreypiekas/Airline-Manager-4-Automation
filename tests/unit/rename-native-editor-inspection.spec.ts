import {test,expect,type Page} from '@playwright/test';
import {inspectNativeRenameEditors,sanitizedRenameCallbackShape,verifiedReadOnlyNativeOpener} from '../../fleet-rename/run';
import {readFile} from 'node:fs/promises';

async function fixture(
 page:Page,unsafeAircraft=false,wrongRoute=false,hiddenEditors=false,
 visibilityCase:'hidden'|'override'|null=null
){
 const first=unsafeAircraft
  ?"Ajax('fleet_details.php?id=1001&mode=reg&reg='+prompt('Sensitive Aircraft','old-name'),'detailsAction');"
  :"Ajax('fleet_details.php?id=1001&mode=reg&reg='+prompt('Sensitive Aircraft'),'detailsAction');";
 const second="Ajax('fleet_details.php?id=101&mode=routeReg&reg='+prompt('Sensitive Route'),'detailsAction');";
 const nativeButtons='<button id="reg" onclick="'+first+'">Aircraft rename</button>'+
  '<button id="routeReg" onclick="'+second+'">Route rename</button>';
 const detailHtml='<div id="ff-name">N-1</div>'+
  '<div class="col-5"><span class="l-text">'+(wrongRoute?'CCC':'AAA')+'</span><span class="l-text">GRU</span></div>'+
  (hiddenEditors?'<div style="display:none">'+nativeButtons+'</div>':
   visibilityCase==='hidden'?'<div style="visibility:hidden">'+nativeButtons+'</div>':
   visibilityCase==='override'?'<div style="visibility:hidden"><div style="visibility:visible">'+nativeButtons+'</div></div>':
   nativeButtons);
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
test('inherited visibility is attributed to parent only when editor is actually hidden',async({page})=>{
 await fixture(page,false,false,false,'hidden');
 const data=await inspectNativeRenameEditors(page,1500);
 expect(data.allVerified).toBe(false);
 expect(data.editors).toMatchObject([
  {visible:false,layoutCause:'ANCESTOR_VISIBILITY_HIDDEN',hiddenAncestorDepth:1},
  {visible:false,layoutCause:'ANCESTOR_VISIBILITY_HIDDEN',hiddenAncestorDepth:1}
 ]);
 expect(await page.evaluate(()=>(window as any).renameRequests)).toBe(0);
 await page.goto('about:blank');
 await fixture(page,false,false,false,'override');
 const overridden=await inspectNativeRenameEditors(page,1500);
 expect(overridden.allVerified).toBe(true);
 expect(overridden.editors).toMatchObject([
  {visible:true,layoutCause:'LAYOUT_PRESENT',hiddenAncestorDepth:null},
  {visible:true,layoutCause:'LAYOUT_PRESENT',hiddenAncestorDepth:null}
 ]);
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
test('read-only form discovery matches exact input references and visible local opener without clicking',async({page})=>{
 const acCb="playSound('neutral_click');Ajax('fleet_details.php?id=1001&mode=reg&reg='+$('#regInput').val(),'detailsAction',this);";
 const rtCb="playSound('neutral_click');Ajax('fleet_details.php?id=101&mode=routeReg&reg='+$('#rtInput').val(),'detailsAction',this);";
 const detailHtml='<div id="ff-name">N-1</div>'+
  '<div class="col-5"><span class="l-text">AAA</span><span class="l-text">GRU</span></div>'+
  '<span onclick="$(\'#aircraftEdit\').show();">Open aircraft editor</span>'+
  '<span onclick="$(\'#routeEdit\').show();">Open route editor</span>'+
  '<div id="aircraftEdit" style="display:none"><div><span>'+
   '<input id="regInput" type="text" value="private-current-registration">'+
   '<button onclick="'+acCb+'">Save aircraft</button>'+
  '</span></div></div>'+
  '<div id="routeEdit" style="display:none"><div><span>'+
   '<input id="rtInput" type="text" value="private-route-name">'+
   '<button onclick="'+rtCb+'">Save route</button>'+
  '</span></div></div>';
 await page.setContent(`<button>Routes (1)</button><div id="routesContainer">
  <div id="routeMainList101"><span class="s-text">AAA - GRU</span>
   <a id="openPlane">N-1 - Aircraft</a></div></div>
  <div id="detailsAction" style="display:none"></div>
  <script>
   window.detailsOpens=0;window.formOpens=0;window.renameRequests=0;
   const intro=0;function playSound(){}
   function $(s){return {hide(){},show(){window.formOpens++;}}}
   function Ajax(url){
    if(url==='fleet_details.php?id=1001'){
     window.detailsOpens++;
     const d=document.getElementById('detailsAction');
     d.innerHTML=${JSON.stringify(detailHtml)};d.style.display='block';
    }else window.renameRequests++;
   }
  </script>`);
 await page.locator('#openPlane').evaluate(e=>e.setAttribute('onclick',
  "playSound('neutral_click');Ajax('fleet_details.php?id=1001','detailsAction');if(intro==0){$('#routeAction').hide();}"));
 const data=await inspectNativeRenameEditors(page,1800);
 expect(data.readOnly).toBe(true);
 expect(data.allVerified).toBe(false);
 expect(data.editors).toMatchObject([
  {field:'aircraft',visible:false,layoutCause:'ANCESTOR_DISPLAY_NONE',
   hiddenAncestorDepth:3,form:{hiddenRegionFound:true,hiddenRegionHasId:true,
    inputCount:1,matchingInputCount:1,matchingInputKind:'TEXT',matchingInputVisible:false,
    openerCount:1,openerShapes:['ID(Q).show();']}},
  {field:'route',visible:false,layoutCause:'ANCESTOR_DISPLAY_NONE',
   hiddenAncestorDepth:3,form:{hiddenRegionFound:true,hiddenRegionHasId:true,
    inputCount:1,matchingInputCount:1,matchingInputKind:'TEXT',matchingInputVisible:false,
    openerCount:1,openerShapes:['ID(Q).show();']}}
 ]);
 const serialized=JSON.stringify(data);
 for(const secret of ['regInput','rtInput','aircraftEdit','routeEdit',
  'private-current-registration','private-route-name','1001','101'])
  expect(serialized).not.toContain(secret);
 expect(await page.evaluate(()=>(window as any).detailsOpens)).toBe(1);
 expect(await page.evaluate(()=>(window as any).formOpens)).toBe(0);
 expect(await page.evaluate(()=>(window as any).renameRequests)).toBe(0);
});
test('native read-only opener requires exact hide-show chain with expected region',()=>{
 const good="$('#planeBadge').hide();$('#planeForm').show();playSound('neutral_click');";
 expect(verifiedReadOnlyNativeOpener(good,'planeForm')).toBe(true);
 expect(verifiedReadOnlyNativeOpener("$('#routeBadge').hide();$('#routeForm').show();",'routeForm')).toBe(true);
 for(const callback of [
  "Ajax('fleet_details.php?id=99&mode=reg&reg=HACK','detailsAction');",
  "eval('unsafe');$('#planeForm').show();",
  "$('#planeBadge').hide();$('#planeForm').show();Ajax('edit.php');",
  "$('#planeBadge').hide();$('#planeForm').show();$('#name').val('HACK');",
  "$('#planeBadge').hide();$('#otherForm').show();",
  "$('#planeForm').hide();$('#planeForm').show();",
  "$('#planeBadge').hide();$('#planeForm').toggle();",
  "$('#planeBadge').hide();$('#planeForm').show();playSound('other');"
 ])expect(verifiedReadOnlyNativeOpener(callback,'planeForm')).toBe(false);
});
test('inspect-open uses only strictly verified native show/hide controls; never writes names',async({page})=>{
 const acCb="playSound('neutral_click');Ajax('fleet_details.php?id=1001&mode=reg&reg='+$('#regInput').val(),'detailsAction',this);";
 const rtCb="playSound('neutral_click');Ajax('fleet_details.php?id=101&mode=routeReg&reg='+$('#rtInput').val(),'detailsAction',this);";
 const detailsHtml='<div id="ff-name">N-1</div>'+
  '<div class="col-5"><span class="l-text">AAA</span><span class="l-text">GRU</span></div>'+
  '<span id="aircraftBadge" onclick="$(\'#aircraftBadge\').hide();$(\'#planeForm\').show();playSound(\'neutral_click\');">Open aircraft editor</span>'+
  '<span id="routeBadge" onclick="$(\'#routeBadge\').hide();$(\'#routeForm\').show();">Open route editor</span>'+
  '<div id="planeForm" style="display:none"><div><span>'+
   '<input id="regInput" type="text" value="PRIVATE-AIRCRAFT-REGISTRATION">'+
   '<button id="savePlane" onclick="'+acCb+'">Save aircraft</button></span></div></div>'+
  '<div id="routeForm" style="display:none"><div><span>'+
   '<input id="rtInput" type="text" value="PRIVATE-ROUTE-NAME">'+
   '<button id="saveRoute" onclick="'+rtCb+'">Save route</button></span></div></div>';
 await page.setContent(`<button>Routes (1)</button><div id="routesContainer">
  <div id="routeMainList101"><span class="s-text">AAA - GRU</span>
   <a id="openPlane">N-1 - Aircraft</a></div></div>
  <div id="detailsAction" style="display:none"></div>
  <script>
   window.detailsOpens=0;window.nativeToggles=0;window.renameRequests=0;
   const intro=0;function playSound(){}
   function $(s){return {
    hide(){document.querySelector(s).style.display='none';window.nativeToggles++;},
    show(){document.querySelector(s).style.display='block';window.nativeToggles++;},
    val(){throw Error('INSPECT_CANNOT_READ_FORM_VALUE');}
   }}
   function Ajax(url){
    if(url==='fleet_details.php?id=1001'){
     window.detailsOpens++;
     const d=document.getElementById('detailsAction');
     d.innerHTML=${JSON.stringify(detailsHtml)};d.style.display='block';
    }else window.renameRequests++;
   }
  </script>`);
 await page.locator('#openPlane').evaluate(e=>e.setAttribute('onclick',
  "playSound('neutral_click');Ajax('fleet_details.php?id=1001','detailsAction');if(intro==0){$('#routeAction').hide();}"));
 const info=await inspectNativeRenameEditors(page,1800,true);
 expect(info.readOnly).toBe(true);expect(info.allVerified).toBe(false);
 expect(info.editors).toMatchObject([
  {field:'aircraft',form:{openerStrictlyVerified:true,openerActivated:true,
   buttonVisibleAfterOpener:true,inputVisibleAfterOpener:true}},
  {field:'route',form:{openerStrictlyVerified:true,openerActivated:true,
   buttonVisibleAfterOpener:true,inputVisibleAfterOpener:true}}
 ]);
 const report=JSON.stringify(info);
 for(const secret of ['PRIVATE-AIRCRAFT-REGISTRATION','PRIVATE-ROUTE-NAME','regInput','rtInput','1001','101'])
  expect(report).not.toContain(secret);
 expect(await page.evaluate(()=>(window as any).nativeToggles)).toBe(4);
 expect(await page.evaluate(()=>(window as any).renameRequests)).toBe(0);
 expect(await page.evaluate(()=>(window as any).detailsOpens)).toBe(1);
});
test('manual workflow contains inspect as explicit operation, never as scheduled job',async()=>{
 const file=await readFile('.github/workflows/manual-fleet-rename.yml','utf8');
 expect(file).toContain('options: [preview, inspect, inspect-open, pilot-check, pilot, apply]');
 expect(file).toContain("github.event_name == 'workflow_dispatch'");
 expect(file).not.toMatch(/cron:|schedule:/);
});
