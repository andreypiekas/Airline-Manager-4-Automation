import type {Page} from '@playwright/test';
import {mkdir,open,writeFile,rename} from 'node:fs/promises';
import {join} from 'node:path';
import {loginForReadOnlyCollection} from '../utils/read-only-login';
import {assertNoInteractiveChallenge} from '../utils/challenge-guard';
import {collectRenameInventory} from './inventory';
import {aircraftIdFromDetailsControl} from '../demand/identity';
import {openFleetList,findFleetRoute} from '../demand/navigation';
import {generateRenames,mappingTemplate,exportRenameCsv,authorizeRenameOperation,authorizeSingleAircraftPilot,selectSingleAircraftPilotTarget,assertRenameRouteLabelUnchanged,assertRenameDetailAirportsMatch,type RenameTarget} from './plan';
import type {CollectionResult} from '../demand/types';

/** Only stable diagnostic codes; never persist or log raw Playwright exceptions,
 * DOM contents, callback source, credentials or the current page URL. */
export function safeRenameFailureCode(error:unknown):string{
 const msg=error instanceof Error?error.message:'';
 if(['INTERACTIVE_CHALLENGE_DETECTED_STOP','READ_ONLY_LOGIN_OR_LOADING_FAILED',
     'READ_ONLY_CREDENTIALS_MISSING'].includes(msg))return msg;
 if(/^(?:RENAME|RESEARCH)_[A-Z0-9_]{1,100}$/.test(msg))return msg;
 if(/timeout|timed out|toBe\(/i.test(msg))return 'RENAME_UI_WAIT_TIMEOUT';
 return 'RENAME_UNCLASSIFIED_FAILURE';
}
export type RenamePhase='aircraft'|'route';
export interface RenameEditorFormInspection {
 // Read-only shape of the native inline form, NEVER its input value/label/id.
 hiddenRegionFound:boolean;hiddenRegionHasId:boolean;
 inputCount:number;matchingInputCount:number;
 matchingInputKind:'TEXT'|'TEXTAREA'|'OTHER'|'NONE'|'AMBIGUOUS';
 matchingInputVisible:boolean;
 openerCount:number;openerShapes:string[];
 openerStrictlyVerified:boolean;openerActivated:boolean;
 buttonVisibleAfterOpener:boolean;inputVisibleAfterOpener:boolean;
}
export interface NativeRenameEditorObservation {
 field:RenamePhase;candidateCount:number;visible:boolean;enabled:boolean;
 callbackVerified:boolean;callbackShape:string;
 // Only bounded enumerated UI classifications. No DOM attributes, identifiers or source.
 layoutCause:string;hiddenAncestorDepth:number|null;
 form:RenameEditorFormInspection;
}
export interface NativeRenameEditorInspection {
 inspected:1;routeCount:number;readOnly:true;editors:NativeRenameEditorObservation[];
 allVerified:boolean;
}
export interface RenameOutcome {
 aircraftId:string;routeId:string;field:RenamePhase;
 desired:string;status:'attempting'|'confirmed'|'held'|'outcome_unknown';
 reason:string;
}
function compactCallback(s:string){return s.replace(/\s/g,'');}
/** Browser dialog/native AJAX only, never forge server requests or use a direct API. */
export function verifiedPromptRenameCallback(callback:string,id:string,mode:'reg'|'routeReg'):boolean {
 const plain=compactCallback(callback);
 if(!/^[1-9]\d*$/.test(id)||plain.length>400)return false;
 const escaped=`fleet_details\\.php\\?id=${id}&mode=${mode}&`;
 // Require the prompt return value to be concatenated directly into the
 // ONLY AJAX command, for the correct field and ID. A handler that merely
 // mentions 'prompt' and 'Ajax' is not sufficient to authorize mutation.
 const exact=new RegExp("^Ajax\\('" + escaped + "[A-Za-z0-9_]+='\\+prompt\\('[^']{1,160}'\\),'[A-Za-z0-9_-]+'\\);$");
 return exact.test(plain);
}
/** Never persist raw native callback strings or page text. Literals, identifiers
 * and numbers become coarse tokens, keeping the operator/prompt structure
 * needed to diagnose unsupported UI safely. */
/** Only UI hide + UI show of the exact native hidden region (optional
 * neutral sound) is safe to click as a read-only probe. Strictly rejects
 * AJAX, forms, input writes, arbitrary JavaScript and unknown handlers. */
export function verifiedReadOnlyNativeOpener(callback:string,hiddenRegionId:string):boolean{
 if(!/^[A-Za-z][A-Za-z0-9_-]{0,90}$/.test(hiddenRegionId))return false;
 const normalized=callback.replace(/\s/g,'');
 if(normalized.length>300)return false;
 const match=/^\$\('(#[-A-Za-z0-9_]+)'\)\.hide\(\);\$\('(#[-A-Za-z0-9_]+)'\)\.show\(\);(?:playSound\('neutral_click'\);)?$/.exec(normalized);
 return !!match&&match[2]==='#'+hiddenRegionId&&match[1]!==match[2];
}
export function sanitizedRenameCallbackShape(raw:string):string{
 if(raw.length>1200)return 'TOO_LONG';
 const replaced=raw.replace(/'(?:\\.|[^'\\])*'|"(?:\\.|[^"\\])*"/g,'Q');
 if(/['"`]/.test(replaced))return 'UNKNOWN_QUOTING';
 return replaced.replace(/[A-Za-z_$][A-Za-z0-9_$]*/g,w=>
  ['Ajax','playSound','prompt','encodeURIComponent','encodeURI','escape',
   'trim','replace','toUpperCase','toLowerCase','val','return','if','this',
   'true','false','null','Q','show','toggle','fadeIn','slideDown'].includes(w)?w:'ID'
 ).replace(/\d+/g,'N').replace(/\s+/g,'').slice(0,300);
}
/** Audit exactly one native aircraft's two rename editors via read-only
 * navigation. NEVER click either editor, accept a prompt or send an edit AJAX. */
export async function inspectNativeRenameEditors(
 page:Page,timeout=14000,openVerifiedNativeForms=false
):Promise<NativeRenameEditorInspection>{
 await assertNoInteractiveChallenge(page,'rename:editor-inspection');
 const heading=page.getByRole('button',{name:/^Routes\s*\(\d+\)$/});
 if(await heading.count()!==1)throw Error('RENAME_INSPECT_FLEET_COUNT_UNVERIFIED');
 const match=/^Routes\s*\((\d+)\)$/.exec((await heading.innerText({timeout})).trim());
 const routeCount=match?Number(match[1]):0;
 if(!Number.isSafeInteger(routeCount)||routeCount<1)
  throw Error('RENAME_INSPECT_FLEET_COUNT_UNVERIFIED');
 const rows=page.locator('#routesContainer [id^="routeMainList"]');
 const row=rows.first();
 if(!await row.isVisible())throw Error('RENAME_INSPECT_ROUTE_NOT_VISIBLE');
 const routeId=(await row.getAttribute('id')||'').replace(/^routeMainList/,'');
 if(!/^[1-9]\d*$/.test(routeId))throw Error('RENAME_INSPECT_ROUTE_ID_UNVERIFIED');
 const labels=await row.locator('span.s-text').allTextContents();
 const matchingLabels=labels.map(l=>l.trim()).filter(l=>/^[A-Z0-9]{3}\s*-\s*[A-Z0-9]{3}$/.test(l));
 if(matchingLabels.length!==1)throw Error('RENAME_INSPECT_ROUTE_LABEL_UNVERIFIED');
 const links=row.locator('a[onclick]');
 const callbacks=await links.evaluateAll(elements=>elements.map(e=>e.getAttribute('onclick')||''));
 const matched=callbacks.flatMap((v,i)=>{
  const id=aircraftIdFromDetailsControl(v);
  return id?[{index:i,id}]:[];
 });
 if(matched.length!==1)throw Error('RENAME_INSPECT_AIRCRAFT_CONTROL_UNVERIFIED');
 const aircraftId=matched[0].id;
 const link=links.nth(matched[0].index);
 if(!await link.isVisible())throw Error('RENAME_INSPECT_AIRCRAFT_CONTROL_UNVERIFIED');
 await assertNoInteractiveChallenge(page,'rename:editor-inspection-before-details');
 await link.click({timeout});
 const details=page.locator('#detailsAction');
 await details.waitFor({state:'visible',timeout});
 await assertNoInteractiveChallenge(page,'rename:editor-inspection-details');
 const observedName=details.locator('#ff-name');
 if(await observedName.count()!==1||!(await observedName.innerText({timeout})).trim())
  throw Error('RENAME_INSPECT_DETAILS_NAME_UNVERIFIED');
 assertRenameDetailAirportsMatch(matchingLabels[0],
  await details.locator('.col-5 span.l-text').allTextContents());
 const buttons=details.locator('button[onclick]');
 const editors:NativeRenameEditorObservation[]=[];
 for(const [field,id,mode] of [
  ['aircraft',aircraftId,'reg'],['route',routeId,'routeReg']
 ] as const){
  const callbacks=await buttons.evaluateAll(es=>es.map(e=>e.getAttribute('onclick')||''));
  const indices=callbacks.flatMap((v,i)=>
   v.includes('fleet_details.php?id='+id+'&mode='+mode+'&')?[i]:[]);
  const button=indices.length===1?buttons.nth(indices[0]):null;
  const cb=button?callbacks[indices[0]]:'';
  const visible=button?await button.isVisible():false;
  const enabled=button?await button.isEnabled():false;
  // Never change the DOM or click hidden elements. Classify the exact visual
  // obstruction while omitting raw CSS values, attributes, text and IDs.
  const layout=button?await button.evaluate(el=>{
   let depth=0;
   for(let node:Element|null=el;node;node=node.parentElement,depth++){
    const css=getComputedStyle(node);
    // Display:none on any ancestor always hides the editor.
    if((node instanceof HTMLElement&&node.hidden)||css.display==='none')
     return {layoutCause:depth===0?'SELF_DISPLAY_NONE':'ANCESTOR_DISPLAY_NONE',
      hiddenAncestorDepth:depth};
   }
   // CSS visibility is inherited but may be explicitly overridden on the
   // child. Only classify an actual hidden editor, then trace the outermost
   // hidden ancestor in the inherited chain.
   const actualVisibility=getComputedStyle(el).visibility;
   if(actualVisibility==='hidden'||actualVisibility==='collapse'){
    let origin:Element=el,originDepth=0;
    while(origin.parentElement){
     const parentVisibility=getComputedStyle(origin.parentElement).visibility;
     if(parentVisibility!=='hidden'&&parentVisibility!=='collapse')break;
     origin=origin.parentElement;originDepth++;
    }
    return {layoutCause:originDepth===0?'SELF_VISIBILITY_HIDDEN':
     'ANCESTOR_VISIBILITY_HIDDEN',hiddenAncestorDepth:originDepth};
   }
   return {layoutCause:el.getClientRects().length?'LAYOUT_PRESENT':'ZERO_RECT',
    hiddenAncestorDepth:null};
  }):{layoutCause:'NOT_FOUND',hiddenAncestorDepth:null};
  // Find native text inputs whose EXACT jQuery .val() expression is used by
  // this button. Read structure only; never read or write any input.value.
  // Also discover visible local controls which MAY open the hidden panel,
  // without clicking them or interpreting untrusted event handlers as safe.
  const rawForm=button?await button.evaluate((el,handler)=>{
   let hidden:Element|null=null;
   for(let node:Element|null=el;node;node=node.parentElement){
    if(getComputedStyle(node).display==='none'||(node instanceof HTMLElement&&node.hidden)){
     hidden=node;break;
    }
   }
   const result={hiddenRegionFound:!!hidden,hiddenRegionHasId:!!hidden?.id,
    hiddenRegionId:hidden?.id||'',matchingInputId:'',
    inputCount:0,matchingInputCount:0,
    matchingInputKind:'NONE' as 'TEXT'|'TEXTAREA'|'OTHER'|'NONE'|'AMBIGUOUS',
    matchingInputVisible:false,openerCodes:[] as string[],openerCount:0};
   if(!hidden)return result;
   const inputs=Array.from(hidden.querySelectorAll('input,textarea')).slice(0,60);
   result.inputCount=inputs.length;
   const matches=inputs.filter(input=>{
    if(!input.id)return false;
    const selector='#'+input.id;
    return handler.includes("$('"+selector+"').val()")||
     handler.includes('$("'+selector+'").val()');
   });
   result.matchingInputCount=matches.length;
   if(matches.length===1){
    const input=matches[0];
    result.matchingInputId=input.id;
    result.matchingInputKind=input.tagName==='TEXTAREA'?'TEXTAREA':
     input instanceof HTMLInputElement&&
     (input.type==='text'||input.type==='search')?'TEXT':'OTHER';
    result.matchingInputVisible=!!input.getClientRects().length;
   }else if(matches.length>1)result.matchingInputKind='AMBIGUOUS';
   if(hidden.id&&hidden.id.length<=100){
    const selector='#'+hidden.id;
    const nodes=Array.from(document.querySelectorAll('#detailsAction [onclick]')).slice(0,300);
    const candidates=nodes.filter(node=>{
     if(hidden!.contains(node)||!node.getClientRects().length)return false;
     const event=node.getAttribute('onclick')||'';
     return event.length<=800&&
      (event.includes("'"+selector+"'")||event.includes('"'+selector+'"'))&&
      /\.(?:show|toggle|fadeIn|slideDown)\(\)/.test(event)&&
      !/Ajax\s*\(|prompt\s*\(|fetch\s*\(|XMLHttpRequest|submit\s*\(/.test(event);
    });
    result.openerCount=candidates.length;
    result.openerCodes=candidates.slice(0,3).map(n=>n.getAttribute('onclick')||'');
   }
   return result;
  },cb):null;
  const openerStrictlyVerified=!!rawForm&&rawForm.openerCount===1&&
   rawForm.matchingInputCount===1&&rawForm.matchingInputKind==='TEXT'&&
   verifiedReadOnlyNativeOpener(rawForm.openerCodes[0],rawForm.hiddenRegionId);
  let openerActivated=false,buttonVisibleAfterOpener=false,inputVisibleAfterOpener=false;
  if(openVerifiedNativeForms&&openerStrictlyVerified&&rawForm){
   // Never use force, evaluate handler code, set values or issue a native AJAX.
   // Click only an exact, unique, visible DOM control whose entire handler
   // has passed verifiedReadOnlyNativeOpener. Stop on any ambiguity.
   const actions=details.locator('[onclick]');
   const openerIndices=await actions.evaluateAll((els,callback)=>
    els.flatMap((el,index)=>(el.getAttribute('onclick')||'')===callback?[index]:[]),
    rawForm.openerCodes[0]);
   if(openerIndices.length===1){
    const opener=actions.nth(openerIndices[0]);
    if(await opener.isVisible()&&await opener.isEnabled()){
     await assertNoInteractiveChallenge(page,'rename:inspect-open-before-click');
     await opener.click({timeout});
     openerActivated=true;
     buttonVisibleAfterOpener=await button!.isVisible();
     if(/^[A-Za-z][A-Za-z0-9_-]{0,90}$/.test(rawForm.matchingInputId)){
      const input=details.locator('[id="'+rawForm.matchingInputId+'"]');
      inputVisibleAfterOpener=await input.count()===1&&await input.isVisible();
     }
     await assertNoInteractiveChallenge(page,'rename:inspect-open-after-click');
    }
   }
  }
  const form:RenameEditorFormInspection=rawForm?{
   hiddenRegionFound:rawForm.hiddenRegionFound,
   hiddenRegionHasId:rawForm.hiddenRegionHasId,
   inputCount:rawForm.inputCount,matchingInputCount:rawForm.matchingInputCount,
   matchingInputKind:rawForm.matchingInputKind,
   matchingInputVisible:rawForm.matchingInputVisible,
   openerCount:rawForm.openerCount,
   openerShapes:rawForm.openerCodes.map(sanitizedRenameCallbackShape),
   openerStrictlyVerified,openerActivated,buttonVisibleAfterOpener,inputVisibleAfterOpener
  }:{
   hiddenRegionFound:false,hiddenRegionHasId:false,
   inputCount:0,matchingInputCount:0,matchingInputKind:'NONE',
   matchingInputVisible:false,openerCount:0,openerShapes:[],
   openerStrictlyVerified:false,openerActivated:false,
   buttonVisibleAfterOpener:false,inputVisibleAfterOpener:false
  };
  editors.push({field,candidateCount:indices.length,visible,enabled,
   callbackVerified:!!button&&visible&&enabled&&verifiedPromptRenameCallback(cb,id,mode),
   callbackShape:button?sanitizedRenameCallbackShape(cb):'NO_EXACT_NATIVE_BUTTON',
   ...layout,form});
 }
 return {inspected:1,routeCount,readOnly:true,editors,
  allVerified:editors.every(e=>e.callbackVerified)};
}
async function inspectTarget(page:Page,expected:RenameTarget,registered:string,timeout:number){
 await assertNoInteractiveChallenge(page,'rename:open-fleet');
 await openFleetList(page,timeout);
 await findFleetRoute(page,{aircraftId:expected.aircraftId,routeId:expected.routeId} as any,timeout);
 const row=page.locator('#routesContainer #routeMainList'+expected.routeId);
 if(await row.count()!==1||!await row.isVisible())throw Error('RENAME_TARGET_MISSING');
 // Re-check native route endpoints on each field, not only aircraft/route IDs.
 // A route can change after the global preview but before an individual save.
 assertRenameRouteLabelUnchanged(expected.oldRouteLabel,await row.locator('span.s-text').allTextContents());
 // The native registration element may be nested in the details link or
 // rendered alongside it. The precise aircraft ID, route ID and handler must
 // all match; the current registration must also match the approved plan.
 const registrationNodes=row.locator('[id^="acRegList"]');
 const registrations=await registrationNodes.count();
 // Some native Fleet cards omit the registration span entirely. This is
 // permitted only when the native details confirm the approved registration
 // AND the complete airport pair after a verified read-only details click.
 if(registrations>1||
    (registrations===1&&(
     await registrationNodes.first().getAttribute('id')!=='acRegList'+expected.aircraftId||
     (await registrationNodes.first().textContent({timeout}))?.trim()!==registered)))
  throw Error('RENAME_AIRCRAFT_IDENTITY_CHANGED');
 const expectedCallback=`playSound('neutral_click');Ajax('fleet_details.php?id=${expected.aircraftId}','detailsAction');if(intro==0){$('#routeAction').hide();}`;
 const links=row.locator('a[onclick]');
 const matches=await links.evaluateAll((elements,callback)=>elements.flatMap((e,index)=>
  (e.getAttribute('onclick')||'').replace(/\s/g,'')===callback?[index]:[]
 ),compactCallback(expectedCallback));
 if(matches.length!==1)throw Error('RENAME_DETAILS_CONTROL_UNVERIFIED');
 const link=links.nth(matches[0]);
 if(!await link.isVisible())throw Error('RENAME_DETAILS_CONTROL_UNVERIFIED');
 await link.click({timeout});
 const details=page.locator('#detailsAction');
 await details.waitFor({state:'visible',timeout});
 if(await details.locator('#ff-name').count()!==1||
    (await details.locator('#ff-name').innerText({timeout})).trim()!==registered)
  throw Error('RENAME_DETAILS_IDENTITY_CHANGED');
 // This always verifies the details endpoints, especially when the card had
 // no registration span to corroborate the identity before opening details.
 assertRenameDetailAirportsMatch(expected.oldRouteLabel,
  await details.locator('.col-5 span.l-text').allTextContents());
 return details;
}
/** A supported game UI exposes a one-shot native prompt + AJAX save action.
 * Unknown UI shapes are held, not guessed and not clicked.
 */
export async function renameNativePrompt(page:Page,details:Awaited<ReturnType<typeof inspectTarget>>,
 target:RenameTarget,field:RenamePhase,desired:string,save:()=>Promise<void>,timeout:number){
 const id=field==='aircraft'?target.aircraftId:target.routeId;
 const mode=field==='aircraft'?'reg':'routeReg';
 const nodes=details.locator('button[onclick]');
 const indices=await nodes.evaluateAll((es,{id,mode})=>es.flatMap((el,index)=>{
  const onclick=el.getAttribute('onclick')||'';
  return onclick.includes('fleet_details.php?id='+id+'&mode='+mode+'&')?[index]:[];
 }),{id,mode});
 if(indices.length!==1)throw Error('RENAME_NATIVE_CONTROL_UNAVAILABLE');
 const button=nodes.nth(indices[0]),callback=await button.getAttribute('onclick')||'';
 if(!await button.isVisible()||!await button.isEnabled()||!verifiedPromptRenameCallback(callback,id,mode))
  throw Error('RENAME_PROMPT_CONTROL_UNVERIFIED');
 await assertNoInteractiveChallenge(page,'rename:before-save');
 // Persist the intent before ANY operation which might reach the server.
 await save();
 let dialogs=0,matchedPrompt=false;
 const onDialog=async(dialog:import('@playwright/test').Dialog)=>{
  dialogs++;
  if(dialog.type()==='prompt'&&dialogs===1){matchedPrompt=true;await dialog.accept(desired);}
  else await dialog.dismiss();
 };
 page.on('dialog',onDialog);
 const expectedOrigin=new URL(page.url()).origin;
 if(expectedOrigin!=='https://www.airlinemanager.com')throw Error('RENAME_SITE_ORIGIN_UNVERIFIED');
 const responsePromise=page.waitForResponse(response=>{
  try{
   const u=new URL(response.url());
   return u.origin===expectedOrigin&&u.pathname.endsWith('/fleet_details.php')&&
    u.searchParams.get('id')===id&&u.searchParams.get('mode')===mode&&
    [...u.searchParams.values()].includes(desired);
  }catch{return false;}
 },{timeout}).catch(()=>null);
 try{
  await button.click({timeout});
  const response=await responsePromise;
  if(!matchedPrompt||dialogs!==1||!response||!response.ok()||await response.finished())
   throw Error('RENAME_NATIVE_RESPONSE_UNCERTAIN');
 }finally{page.off('dialog',onDialog);}
}
function htmlSafe(s:string){return s.replace(/[|<>\r\n]/g,' ');}
export async function runManualFleetRename(page:Page,env:NodeJS.ProcessEnv=process.env,directory='test-results/fleet-rename'){
 const timeout=14000,operation=(env.RENAME_OPERATION||'preview').trim();
 if(!['inspect','inspect-open','preview','pilot-check','pilot','apply'].includes(operation))throw Error('RENAME_OPERATION_INVALID');
 // Until one real double-field pilot is verified, bulk apply must not run.
 if(operation==='apply')throw Error('RENAME_BULK_REQUIRES_VALIDATED_PILOT');
 // Applied runs require first-attempt manual dispatch; no workflow cron or reruns.
 if(operation==='pilot'&&(env.GITHUB_ACTIONS!=='true'||env.GITHUB_EVENT_NAME!=='workflow_dispatch'||
  env.GITHUB_RUN_ATTEMPT!=='1'||env.RENAME_CONFIRMATION!=='APLICAR_PILOTO_UMA_AERONAVE'))
  throw Error('RENAME_REAL_CONTEXT_UNAUTHORIZED');
 await mkdir(directory,{recursive:true});
 const report:{schemaVersion:1;operation:string;generatedAt:string;complete:boolean;halted:boolean;
  fleetCount:number;digest:string|null;results:RenameOutcome[];reason:string;
  stage:string;failureCode:string|null;inspection?:NativeRenameEditorInspection}={
  schemaVersion:1,operation,generatedAt:new Date().toISOString(),complete:false,halted:false,
  fleetCount:0,digest:null,results:[],reason:'INITIALIZING',
  stage:'INITIALIZING',failureCode:null};
 const knownLoginStages=new Set([
  'LOGIN_OPEN_SITE','LOGIN_OPEN_GAME','LOGIN_OPEN_LOGIN','LOGIN_FILL_LOGIN',
  'LOGIN_SUBMIT_LOGIN','LOGIN_WAIT_COMPANY','LOGIN_WAIT_INTRO'
 ]);
 const markStage=(stage:string)=>{
  report.stage=stage;
  console.log('[RenamePreview] stage='+stage);
 };
 const save=async()=>{const out=join(directory,'rename-report.json');await writeFile(out+'.tmp',JSON.stringify(report,null,2)+'\n');await rename(out+'.tmp',out);};
 await save();
 try{
  markStage('LOGIN_OPEN_SITE');
  await loginForReadOnlyCollection(page,env,90000,(phase)=>{
   const code='LOGIN_'+phase.toUpperCase();
   if(knownLoginStages.has(code))markStage(code);
  });
  markStage('OPEN_FLEET');
  await openFleetList(page,timeout,phase=>markStage('OPEN_FLEET_'+phase));
  if(operation==='inspect'||operation==='inspect-open'){
   markStage(operation==='inspect'?'INSPECT_NATIVE_EDITORS':'INSPECT_NATIVE_OPENERS');
   const inspection=await inspectNativeRenameEditors(page,timeout,operation==='inspect-open');
   report.inspection=inspection;report.fleetCount=inspection.routeCount;
   report.complete=true;
   report.reason=inspection.allVerified?
    'NATIVE_EDITORS_VERIFIED_READ_ONLY':'NATIVE_EDITORS_UNVERIFIED_READ_ONLY';
   await save();return report;
  }
  markStage('COLLECT_FLEET');
  const fleet:CollectionResult=await collectRenameInventory(page,timeout);
  markStage('BUILD_PLAN');
  // The snapshot is identity-checked even before a name is planned.
  let plan;
  if(!(env.RENAME_MAPPING_CSV||'').trim()&&!(env.RENAME_AIRCRAFT_PREFIX||'').trim()&&!(env.RENAME_ROUTE_PREFIX||'').trim()&&operation==='preview'){
   const {verifiedFleet}=await import('./plan');const aircraft=verifiedFleet(fleet);
   report.fleetCount=aircraft.length;
   await writeFile(join(directory,'rename-template.csv'),mappingTemplate(fleet));
   await writeFile(join(directory,'rename-inventory.json'),JSON.stringify(aircraft.map(a=>({
    aircraftId:a.aircraftId,routeId:a.routeId,aircraftRegistration:a.registration,routeLabel:a.routeLabel
   })),null,2)+'\n');
   report.complete=true;report.reason='PREVIEW_TEMPLATE_NO_MUTATION';await save();return report;
  }
  plan=generateRenames(fleet,{
   csv:env.RENAME_MAPPING_CSV,aircraftPrefix:env.RENAME_AIRCRAFT_PREFIX,routePrefix:env.RENAME_ROUTE_PREFIX
  });
  report.fleetCount=plan.count;report.digest=plan.digest;
  await writeFile(join(directory,'rename-proposal.csv'),exportRenameCsv(plan));
  await writeFile(join(directory,'rename-proposal.json'),JSON.stringify(plan,null,2)+'\n');
  let pilotTarget:typeof plan.targets[number]|null=null;
  if(operation==='pilot'||operation==='pilot-check'){
   pilotTarget=operation==='pilot'
    ?authorizeSingleAircraftPilot(plan,env.RENAME_PILOT_AIRCRAFT_ID||'',
       env.RENAME_EXPECTED_DIGEST||'',env.RENAME_CONFIRMATION||'')
    :selectSingleAircraftPilotTarget(plan,env.RENAME_PILOT_AIRCRAFT_ID||'',
       env.RENAME_EXPECTED_DIGEST||'');
   markStage('PILOT_PREFLIGHT_OPEN_TARGET_DETAILS');
   const {preflightNativeTextEditors}=await import('./native-pilot');
   const detail=await inspectTarget(page,pilotTarget,pilotTarget.oldAircraftRegistration,timeout);
   // Both editors must be verified before ANY name can be changed.
   await preflightNativeTextEditors(detail,pilotTarget,markStage);
   if(operation==='pilot-check'){
    report.complete=true;
    report.reason='PILOT_PREFLIGHT_VERIFIED_READ_ONLY';
    await save();return report;
   }
  }else if(!authorizeRenameOperation(operation,env.RENAME_CONFIRMATION||'',env.RENAME_EXPECTED_DIGEST||'',plan)){
   report.complete=true;report.reason='PREVIEW_ONLY_NO_MUTATION';await save();return report;
  }
  const marker=await open(join(directory,operation==='pilot'?'rename-pilot.started':'rename-apply.started'),'wx');
  await marker.close();
  for(const target of (pilotTarget?[pilotTarget]:plan.targets)){
   let currentRegistration=target.oldAircraftRegistration;
   for(const field of ['aircraft','route'] as const){
    const desired=field==='aircraft'?target.aircraftRegistration:target.routeRegistration;
    const entry:RenameOutcome={aircraftId:target.aircraftId,routeId:target.routeId,field,desired,
      status:'held',reason:'NOT_STARTED'};
    report.results.push(entry);await save();
    let mutationStarted=false;
    try{
     const details=await inspectTarget(page,target,currentRegistration,timeout);
     // A new explicitly approved preview may follow a previous partially
     // completed attempt. Never click if live UI already confirms the target.
     const alreadyCorrect=field==='aircraft'
       ?currentRegistration===desired
       :(await details.locator('#route-name').innerText({timeout})).trim().split(/\s+/).includes(desired);
     if(alreadyCorrect){
       entry.status='confirmed';entry.reason='ALREADY_MATCHES_LIVE_REGISTRATION';
       await save();continue;
     }
     if(operation==='pilot'){
      const {preflightNativeTextEditors,saveNativeTextField}=await import('./native-pilot');
      const editors=await preflightNativeTextEditors(details,target,markStage);
      const editor=editors.find(e=>e.field===field);
      if(!editor)throw Error('RENAME_PILOT_EDITOR_MISSING');
      await saveNativeTextField(page,editor,desired,async()=>{
       mutationStarted=true;
       entry.status='attempting';entry.reason='INTENT_CHECKPOINTED';
       await save();
      },timeout);
     }else{
      entry.status='attempting';entry.reason='INTENT_CHECKPOINTED';
      await renameNativePrompt(page,details,target,field,desired,async()=>{
       mutationStarted=true;await save();
      },timeout);
     }
     const verify=await inspectTarget(page,target,field==='aircraft'?desired:currentRegistration,timeout);
     if(field==='route'){
      // Route registration must be shown in the route-specific header after
      // save. An AJAX 200 alone is NOT confirmation.
      const label=(await verify.locator('#route-name').innerText({timeout})).trim();
      if(!label.split(/\s+/).includes(desired))throw Error('RENAME_ROUTE_VALUE_NOT_VISIBLE');
     }else currentRegistration=desired;
     entry.status='confirmed';entry.reason='NATIVE_UI_AND_RESPONSE_VERIFIED';await save();
    }catch(e){
     const raw=e instanceof Error?e.message:'UNCLASSIFIED';
     entry.status=mutationStarted?'outcome_unknown':'held';
     entry.reason=/^[A-Z0-9_:-]{1,120}$/.test(raw)?raw:'RENAME_UI_UNVERIFIED';
     report.halted=true;report.reason=entry.status==='outcome_unknown'?'RENAME_UNCERTAIN_NO_RETRY':'RENAME_UNSUPPORTED_OR_CHANGED_UI';
     await save();
     throw Error(report.reason);
    }
   }
  }
  report.complete=true;
  report.reason=operation==='pilot'?'PILOT_TWO_FIELDS_NATIVE_VERIFIED':'ALL_FIELDS_NATIVE_VERIFIED';
  await save();return report;
 }catch(e){
  report.halted=true;
  report.failureCode=safeRenameFailureCode(e);
  // Preserve only a stable, non-sensitive stage for unexpected native UI
  // exceptions. Never record raw exception/HTML/callbacks or input values.
  if(report.failureCode==='RENAME_UNCLASSIFIED_FAILURE'&&
     report.stage.startsWith('PILOT_PREFLIGHT_'))
   report.failureCode='RENAME_PILOT_PREFLIGHT_UI_EXCEPTION';
  if(report.reason==='INITIALIZING')
   report.reason=operation==='pilot-check'?'RENAME_PILOT_CHECK_FAILED_READ_ONLY':
    'RENAME_PREVIEW_OR_LOGIN_FAILED';
  console.log('[RenamePreview] failed stage='+report.stage+' code='+report.failureCode);
  await save();
  throw Error(report.reason);
 }finally{
  await writeFile(join(directory,'rename-report.md'),[
   '# Renomeação manual da frota','',
   'Modo: '+htmlSafe(operation)+'; frota: '+report.fleetCount+'; hash: '+(report.digest||'não disponível')+
   '; resultado: '+htmlSafe(report.reason)+'; fase: '+htmlSafe(report.stage)+'; falha: '+htmlSafe(report.failureCode||'nenhuma'),'',
   '| Aircraft ID | Route ID | Campo | Destino | Estado | Motivo |',
   '| --- | --- | --- | --- | --- | --- |',
   ...report.results.map(e=>`| ${e.aircraftId} | ${e.routeId} | ${e.field} | ${htmlSafe(e.desired)} | ${e.status} | ${htmlSafe(e.reason)} |`),'',
   ...(report.inspection?['','## Inspeção nativa (somente leitura)',
     '| Campo | Candidatos | Visível | Habilitado | Verificado | Ocultação | Nível | Callback anonimizado |',
     '| --- | ---: | --- | --- | --- | --- | ---: | --- |',
     ...report.inspection.editors.map(e=>`| ${e.field} | ${e.candidateCount} | ${e.visible} | ${e.enabled} | ${e.callbackVerified} | ${e.layoutCause} | ${e.hiddenAncestorDepth??'-'} | ${htmlSafe(e.callbackShape)} |`),
     '','## Formulários de edição (estrutura somente leitura)',
     '| Campo | Região oculta | Possui ID | Inputs | Input usado pelo botão | Tipo | Aberturas | Verificado | Acionado | Botão visível | Input visível | Callback anônimo |',
     '| --- | --- | --- | ---: | ---: | --- | ---: | --- | --- | --- | --- | --- |',
     ...report.inspection.editors.map(e=>`| ${e.field} | ${e.form.hiddenRegionFound} | ${e.form.hiddenRegionHasId} | ${e.form.inputCount} | ${e.form.matchingInputCount} | ${e.form.matchingInputKind} | ${e.form.openerCount} | ${e.form.openerStrictlyVerified} | ${e.form.openerActivated} | ${e.form.buttonVisibleAfterOpener} | ${e.form.inputVisibleAfterOpener} | ${e.form.openerShapes.map(htmlSafe).join(' ; ')} |`)]:[]),
   'Não repetir automaticamente controles com resultado incerto. Os modos inspect e preview não alteram o jogo.'
  ].join('\n')+'\n');
 }
}
