import type {Page} from '@playwright/test';
import {mkdir,open,writeFile,rename} from 'node:fs/promises';
import {join} from 'node:path';
import {loginForReadOnlyCollection} from '../utils/read-only-login';
import {assertNoInteractiveChallenge} from '../utils/challenge-guard';
import {collectRenameInventory} from './inventory';
import {openFleetList,findFleetRoute} from '../demand/navigation';
import {generateRenames,mappingTemplate,exportRenameCsv,authorizeRenameOperation,assertRenameRouteLabelUnchanged,assertRenameDetailAirportsMatch,type RenameTarget} from './plan';
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
 if(!['preview','apply'].includes(operation))throw Error('RENAME_OPERATION_INVALID');
 // Applied runs require first-attempt manual dispatch; no workflow cron or reruns.
 if(operation==='apply'&&(env.GITHUB_ACTIONS!=='true'||env.GITHUB_EVENT_NAME!=='workflow_dispatch'||
  env.GITHUB_RUN_ATTEMPT!=='1'||env.RENAME_CONFIRMATION!=='APLICAR_RENOMEACAO_TOTAL'))
  throw Error('RENAME_REAL_CONTEXT_UNAUTHORIZED');
 await mkdir(directory,{recursive:true});
 const report:{schemaVersion:1;operation:string;generatedAt:string;complete:boolean;halted:boolean;
  fleetCount:number;digest:string|null;results:RenameOutcome[];reason:string;
  stage:string;failureCode:string|null}={
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
  if(!authorizeRenameOperation(operation,env.RENAME_CONFIRMATION||'',env.RENAME_EXPECTED_DIGEST||'',plan)){
   report.complete=true;report.reason='PREVIEW_ONLY_NO_MUTATION';await save();return report;
  }
  const marker=await open(join(directory,'rename-apply.started'),'wx');await marker.close();
  for(const target of plan.targets){
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
     entry.status='attempting';entry.reason='INTENT_CHECKPOINTED';
     await renameNativePrompt(page,details,target,field,desired,async()=>{
      mutationStarted=true;await save();
     },timeout);
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
  report.complete=true;report.reason='ALL_FIELDS_NATIVE_VERIFIED';await save();return report;
 }catch(e){
  report.halted=true;
  report.failureCode=safeRenameFailureCode(e);
  if(report.reason==='INITIALIZING')report.reason='RENAME_PREVIEW_OR_LOGIN_FAILED';
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
   'Não repetir automaticamente controles com resultado incerto. A prévia não altera o jogo.'
  ].join('\n')+'\n');
 }
}
