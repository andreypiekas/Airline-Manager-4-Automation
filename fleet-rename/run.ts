import type {Page} from '@playwright/test';
import {mkdir,open,writeFile,rename} from 'node:fs/promises';
import {join} from 'node:path';
import {loginForReadOnlyCollection} from '../utils/read-only-login';
import {assertNoInteractiveChallenge} from '../utils/challenge-guard';
import {collectFleetWithFreshRetry} from '../demand/reader';
import {openFleetList,findFleetRoute} from '../demand/navigation';
import {generateRenames,mappingTemplate,exportRenameCsv,authorizeRenameOperation,type RenameTarget} from './plan';
import type {CollectionResult} from '../demand/types';

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
 return /^[1-9]\d*$/.test(id)&&
  plain.includes(`fleet_details.php?id=${id}&mode=${mode}&`) &&
  /\bprompt\(/.test(plain)&&/\bAjax\(/.test(plain)&&
  !/\b(?:eval|fetch|XMLHttpRequest|location|open)\s*\(/.test(plain)&&plain.length<=600;
}
async function inspectTarget(page:Page,expected:RenameTarget,registered:string,timeout:number){
 await assertNoInteractiveChallenge(page,'rename:open-fleet');
 await openFleetList(page,timeout);
 await findFleetRoute(page,{aircraftId:expected.aircraftId,routeId:expected.routeId} as any,timeout);
 const row=page.locator('#routesContainer #routeMainList'+expected.routeId);
 if(await row.count()!==1||!await row.isVisible())throw Error('RENAME_TARGET_MISSING');
 const link=row.locator('a').filter({has:row.locator('#acRegList'+expected.aircraftId)});
 if(await link.count()!==1||await row.locator('#acRegList'+expected.aircraftId).innerText()!==registered)
  throw Error('RENAME_AIRCRAFT_IDENTITY_CHANGED');
 const expectedCallback=`playSound('neutral_click');Ajax('fleet_details.php?id=${expected.aircraftId}','detailsAction');if(intro==0){$('#routeAction').hide();}`;
 if(compactCallback(await link.getAttribute('onclick')||'')!==compactCallback(expectedCallback))
  throw Error('RENAME_DETAILS_CONTROL_UNVERIFIED');
 await link.click({timeout});
 const details=page.locator('#detailsAction');
 await details.waitFor({state:'visible',timeout});
 if((await details.locator('#ff-name').innerText({timeout})).trim()!==registered)
  throw Error('RENAME_DETAILS_IDENTITY_CHANGED');
 return details;
}
/** A supported game UI exposes a one-shot native prompt + AJAX save action.
 * Unknown UI shapes are held, not guessed and not clicked.
 */
async function renameNativePrompt(page:Page,details:Awaited<ReturnType<typeof inspectTarget>>,
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
  fleetCount:number;digest:string|null;results:RenameOutcome[];reason:string}={
  schemaVersion:1,operation,generatedAt:new Date().toISOString(),complete:false,halted:false,
  fleetCount:0,digest:null,results:[],reason:'INITIALIZING'};
 const save=async()=>{const out=join(directory,'rename-report.json');await writeFile(out+'.tmp',JSON.stringify(report,null,2)+'\n');await rename(out+'.tmp',out);};
 await save();
 try{
  await loginForReadOnlyCollection(page,env,90000);
  await openFleetList(page,timeout);
  const fleet:CollectionResult=await collectFleetWithFreshRetry(page,timeout,false);
  // The snapshot is identity-checked even before a name is planned.
  let plan;
  if(!(env.RENAME_MAPPING_CSV||'').trim()&&!(env.RENAME_AIRCRAFT_PREFIX||'').trim()&&operation==='preview'){
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
  if(report.reason==='INITIALIZING')report.reason='RENAME_PREVIEW_OR_LOGIN_FAILED';
  await save();
  throw Error(report.reason);
 }finally{
  await writeFile(join(directory,'rename-report.md'),[
   '# Renomeação manual da frota','',
   'Modo: '+htmlSafe(operation)+'; frota: '+report.fleetCount+'; hash: '+(report.digest||'não disponível')+
   '; resultado: '+htmlSafe(report.reason),'',
   '| Aircraft ID | Route ID | Campo | Destino | Estado | Motivo |',
   '| --- | --- | --- | --- | --- | --- |',
   ...report.results.map(e=>`| ${e.aircraftId} | ${e.routeId} | ${e.field} | ${htmlSafe(e.desired)} | ${e.status} | ${htmlSafe(e.reason)} |`),'',
   'Não repetir automaticamente controles com resultado incerto. A prévia não altera o jogo.'
  ].join('\n')+'\n');
 }
}
