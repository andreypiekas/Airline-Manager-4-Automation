import type {Page,Locator} from '@playwright/test';
import {assertNoInteractiveChallenge} from '../utils/challenge-guard';
import {verifiedReadOnlyNativeOpener,type RenamePhase} from './run';
import type {RenameTarget} from './plan';

type NativeMode='reg'|'routeReg';
export type VerifiedNativeTextEditor={
 field:RenamePhase; targetId:string;mode:NativeMode;queryKey:string;
 button:Locator;input:Locator;opener:Locator;
};

/**
 * Accept the exact native UI handler seen in live read-only Fleet,
 * for the selected route/aircraft and selected input. This is NOT an
 * authorization to forge a request; saves always click the verified UI.
 */
export function nativeTextSaveQueryKey(callback:string,id:string,mode:NativeMode,inputId:string):string|null{
 if(!/^[1-9]\d*$/.test(id)||!/^[A-Za-z][A-Za-z0-9_-]{0,90}$/.test(inputId))return null;
 if(callback.length>600)return null;
 const compact=callback.replace(/\s/g,'');
 const exact=new RegExp(
  "^playSound\\('neutral_click'\\);Ajax\\('fleet_details\\.php\\?id="+id+
  "&mode="+mode+"&([A-Za-z_][A-Za-z0-9_]{0,24})='\\+\\$\\('#"+inputId+
  "'\\)\\.val\\(\\),'detailsAction',this\\);$");
 const matched=exact.exec(compact);
 const key=matched?.[1]||'';
 return key&&key!=='id'&&key!=='mode'?key:null;
}

/** Static stages only: never include callback source, field IDs, route names,
 * error messages, page HTML or input values in a persisted diagnostic.
 */
export type PilotPreflightPhase=
 'PILOT_PREFLIGHT_AIRCRAFT_FIND_CONTROL'|'PILOT_PREFLIGHT_AIRCRAFT_FIND_PANEL'|
 'PILOT_PREFLIGHT_AIRCRAFT_FIND_INPUT'|'PILOT_PREFLIGHT_AIRCRAFT_FIND_OPENER'|
 'PILOT_PREFLIGHT_ROUTE_FIND_CONTROL'|'PILOT_PREFLIGHT_ROUTE_FIND_PANEL'|
 'PILOT_PREFLIGHT_ROUTE_FIND_INPUT'|'PILOT_PREFLIGHT_ROUTE_FIND_OPENER';
/** Preflight both editors before ANY renaming. No input values are read here. */
export async function preflightNativeTextEditors(
 details:Locator,target:RenameTarget,onPhase:(phase:PilotPreflightPhase)=>void=()=>{}
):Promise<VerifiedNativeTextEditor[]>{
 const results:VerifiedNativeTextEditor[]=[];
 for(const field of ['aircraft','route'] as const){
  const phase=(step:'FIND_CONTROL'|'FIND_PANEL'|'FIND_INPUT'|'FIND_OPENER')=>
   onPhase(('PILOT_PREFLIGHT_'+field.toUpperCase()+'_'+step) as PilotPreflightPhase);
  phase('FIND_CONTROL');
  const id=field==='aircraft'?target.aircraftId:target.routeId;
  const mode:NativeMode=field==='aircraft'?'reg':'routeReg';
  const buttons=details.locator('button[onclick]');
  const candidates=await buttons.evaluateAll((els,{id,mode})=>els.flatMap((el,i)=>
   (el.getAttribute('onclick')||'').includes('fleet_details.php?id='+id+'&mode='+mode+'&')?[i]:[]
  ),{id,mode});
  if(candidates.length!==1)throw Error('RENAME_PILOT_EDITOR_AMBIGUOUS');
  const button=buttons.nth(candidates[0]);
  if(!await button.isEnabled())throw Error('RENAME_PILOT_EDITOR_DISABLED');
  const callback=await button.getAttribute('onclick')||'';
  phase('FIND_PANEL');
  const hiddenId=await button.evaluate(node=>{
   for(let current:Element|null=node;current;current=current.parentElement){
    if(getComputedStyle(current).display==='none'||
       (current instanceof HTMLElement&&current.hidden))
     return current.id;
   }
   return '';
  });
  if(!/^[A-Za-z][A-Za-z0-9_-]{0,90}$/.test(hiddenId))
   throw Error('RENAME_PILOT_HIDDEN_REGION_UNVERIFIED');
  const hidden=details.locator('[id="'+hiddenId+'"]');
  if(await hidden.count()!==1)throw Error('RENAME_PILOT_HIDDEN_REGION_AMBIGUOUS');
  phase('FIND_INPUT');
  // HTML inputs with an omitted type attribute default to type=text.
  // Match their actual browser type; never accept password, hidden or submit.
  const inputs=hidden.locator('input');
  const inputIds=await inputs.evaluateAll(els=>els.map(el=>
   el instanceof HTMLInputElement&&(el.type==='text'||el.type==='search')?
    el.id||'':''
  ));
  const matching=inputIds.flatMap((inputId,i)=>
   nativeTextSaveQueryKey(callback,id,mode,inputId)?[i]:[]);
  if(matching.length!==1)throw Error('RENAME_PILOT_INPUT_AMBIGUOUS');
  const input=inputs.nth(matching[0]);
  const inputId=inputIds[matching[0]];
  const queryKey=nativeTextSaveQueryKey(callback,id,mode,inputId);
  if(!queryKey||await details.locator('[id="'+inputId+'"]').count()!==1||
     !await input.isEnabled()||!await input.isEditable())
   throw Error('RENAME_PILOT_INPUT_UNVERIFIED');
  if(await input.getAttribute('oninput')||await input.getAttribute('onchange')||
     await input.getAttribute('onkeyup')||await input.getAttribute('onblur'))
   throw Error('RENAME_PILOT_INPUT_SIDE_EFFECT_UNVERIFIED');
  const limit=await input.getAttribute('maxlength');
  const desired=field==='aircraft'?target.aircraftRegistration:target.routeRegistration;
  if(limit!==null&&(!/^\d{1,4}$/.test(limit)||Number(limit)<desired.length))
   throw Error('RENAME_PILOT_INPUT_LENGTH_UNVERIFIED');
  phase('FIND_OPENER');
  const controls=details.locator('[onclick]');
  const verified=await controls.evaluateAll((els,{hiddenId})=>els.flatMap((el,i)=>{
   const cb=el.getAttribute('onclick')||'';
   // Candidate filter only. Exact parser runs below in Node.
   return cb.includes("'#"+hiddenId+"'")&&cb.includes('.show()')?[i]:[];
  }),{hiddenId});
  const matches:Array<{index:number,code:string}>=[];
  for(const i of verified){
   const opener=controls.nth(i);
   const code=await opener.getAttribute('onclick')||'';
   if(verifiedReadOnlyNativeOpener(code,hiddenId)&&await opener.isVisible()&&await opener.isEnabled())
    matches.push({index:i,code});
  }
  if(matches.length!==1)throw Error('RENAME_PILOT_OPENER_UNVERIFIED');
  results.push({field,targetId:id,mode,queryKey,button,input,
   opener:controls.nth(matches[0].index)});
 }
 if(results.length!==2)throw Error('RENAME_PILOT_TWO_FIELDS_REQUIRED');
 return results;
}

/** Exactly one native save click. The callback checkpoints intent before click.
 * Any failure after checkpoint is reported as uncertain, NEVER retried.
 */
export async function saveNativeTextField(
 page:Page,editor:VerifiedNativeTextEditor,desired:string,
 checkpoint:()=>Promise<void>,timeout:number
):Promise<void>{
 if(!/^[A-Za-z0-9][A-Za-z0-9 ._-]{0,31}$/.test(desired))
  throw Error('RENAME_PILOT_NAME_INVALID');
 const origin=new URL(page.url()).origin;
 if(origin!=='https://www.airlinemanager.com')throw Error('RENAME_SITE_ORIGIN_UNVERIFIED');
 await assertNoInteractiveChallenge(page,'rename:pilot-before-opener');
 if(!await editor.opener.isVisible()||!await editor.opener.isEnabled())
  throw Error('RENAME_PILOT_OPENER_CHANGED');
 await editor.opener.click({timeout});
 if(!await editor.input.isVisible()||!await editor.input.isEnabled()||
    !await editor.button.isVisible()||!await editor.button.isEnabled())
  throw Error('RENAME_PILOT_EDITOR_NOT_VISIBLE');
 const cb=await editor.button.getAttribute('onclick')||'';
 const inputId=await editor.input.getAttribute('id')||'';
 if(nativeTextSaveQueryKey(cb,editor.targetId,editor.mode,inputId)!==editor.queryKey)
  throw Error('RENAME_PILOT_EDITOR_CHANGED');
 if(await editor.input.getAttribute('oninput')||await editor.input.getAttribute('onchange')||
    await editor.input.getAttribute('onkeyup')||await editor.input.getAttribute('onblur'))
  throw Error('RENAME_PILOT_INPUT_SIDE_EFFECT_UNVERIFIED');
 await assertNoInteractiveChallenge(page,'rename:pilot-before-input');
 // This only sets a local text field. The native UI's Save is the sole
 // operation allowed to send a request; no direct/fabricated AJAX.
 await editor.input.fill(desired,{timeout});
 if(await editor.input.inputValue()!==desired)throw Error('RENAME_PILOT_INPUT_VALUE_UNVERIFIED');
 await assertNoInteractiveChallenge(page,'rename:pilot-before-save');
 await checkpoint();
 const expectedPath='/fleet_details.php';
 const responsePromise=page.waitForResponse(response=>{
  try{
   const url=new URL(response.url());
   return url.origin===origin&&url.pathname.endsWith(expectedPath)&&
    url.searchParams.get('id')===editor.targetId&&
    url.searchParams.get('mode')===editor.mode&&
    url.searchParams.get(editor.queryKey)===desired;
  }catch{return false;}
 },{timeout}).catch(()=>null);
 let dialogSeen=false;
 const onDialog=async(d:import('@playwright/test').Dialog)=>{
  dialogSeen=true;await d.dismiss();
 };
 page.on('dialog',onDialog);
 try{
  await editor.button.click({timeout});
  const response=await responsePromise;
  if(dialogSeen||!response||!response.ok()||await response.finished())
   throw Error('RENAME_PILOT_RESPONSE_UNCERTAIN');
 }finally{page.off('dialog',onDialog);}
}