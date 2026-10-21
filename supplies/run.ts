import {Page} from '@playwright/test';
import {mkdir,open,writeFile,rename,readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {readDemandConfig} from '../demand/config';
import {executionEnvironment} from '../demand/execute-run';
import {Commodity,planPurchase,supplyConfig} from './policy';
import {SupplyPort,SupplyPreMutationError} from './port';
import {optimizationConfig} from '../optimization/report';
import {appendSupplyObservation,appendUncertainSupplyOperation,readUnresolvedSupplyKinds,unresolvedSupplyKinds,validateReturnJournal} from '../optimization/return-journal';
import {adaptiveSupplyCap} from './adaptive-policy';
import {calendarReference,loadReference,type FuelCalendar} from '../optimization/reference-data';
import {fuelPriceWindow,type FuelPriceWindow} from './fuel-price-window';
/** CO2 follows its explicit configured ceiling; historical data only tightens fuel. */
export function supplyCapsForRun(journal:Parameters<typeof adaptiveSupplyCap>[0],config:ReturnType<typeof supplyConfig>){
 const co2History=adaptiveSupplyCap(journal,'co2',config.maxPrice.co2);
 return {
   fuel:adaptiveSupplyCap(journal,'fuel',config.maxPrice.fuel),
   co2:{...co2History,effectiveMax:config.maxPrice.co2,source:'configured-cap' as const}
 };
}
export interface SupplyRunOptions{
 phase?:'pre'|'post';
 /** Same finalization-reserved deadline as the departure executor. */
 mutationDeadlineEpochMs?:number;
}
export async function runSupplies(page:Page,dryRun:boolean,env:NodeJS.ProcessEnv=process.env,directory='test-results/demand',
 port=new SupplyPort(page),options:SupplyRunOptions={}){
 const phase=options.phase??'pre',post=phase==='post';
 if(phase!=='pre'&&phase!=='post')throw Error('SUPPLY_PHASE_INVALID');
 const config=supplyConfig(env);const optimization=optimizationConfig(env);
 if(!dryRun)executionEnvironment({...readDemandConfig(env),dryRun:false},env);
 if(post&&(!Number.isSafeInteger(options.mutationDeadlineEpochMs)||options.mutationDeadlineEpochMs===undefined||options.mutationDeadlineEpochMs<=0))
   throw Error('POST_SUPPLY_DEADLINE_INVALID');
 await mkdir(directory,{recursive:true});
 let preReport:any=null;
 if(post){
  // A second pass is never allowed if the first purchase pass was interrupted
  // or a prior purchase outcome is unknown. First-pass volume caps remain
  // binding across BOTH passes in the same GitHub Actions execution.
  try{preReport=JSON.parse(await readFile(join(directory,'supply-report.json'),'utf8'));}catch{
   throw Error('POST_SUPPLY_PRE_REPORT_MISSING');
  }
  if(preReport?.phase!=='pre'||preReport.dryRun!==dryRun||!Array.isArray(preReport.entries)||
     preReport.entries.length!==2||preReport.entries[0]?.kind!=='fuel'||preReport.entries[1]?.kind!=='co2'||
     preReport.halted!==false||
     preReport.entries.some((e:any)=>!['purchased','skipped','would_buy'].includes(e?.status)))
   throw Error('POST_SUPPLY_PRE_REPORT_UNVERIFIED');
 }
 const journal=optimization.returnJournal?validateReturnJournal(JSON.parse(await readFile(join(optimization.returnJournal.directory,'return-journal.json'),'utf8')),optimization.returnJournal.scope,new Date()):{schemaVersion:1 as const,scope:'disabled',entries:[]};
 const blockedSupplyKinds=unresolvedSupplyKinds(journal);
 const adaptive=supplyCapsForRun(journal,config);
 const effectiveConfig={...config,maxPrice:{fuel:adaptive.fuel.effectiveMax,co2:config.maxPrice.co2}};
 const now=new Date(),local=new Date(now.getTime()-180*60000),monthLength=new Date(Date.UTC(local.getUTCFullYear(),local.getUTCMonth()+1,0)).getUTCDate();
 const calendar=await loadReference<FuelCalendar>(monthLength===30?'fuel-calendar-30.json':'fuel-calendar-31.json');
 const forecast={fuel:calendarReference(now,calendar,'fuel'),co2:calendarReference(now,calendar,'co2')};
 if(!dryRun){const marker=await open(join(directory,post?'supplies-post.started':'supplies.started'),'wx');await marker.close();}
 const initialWindow=fuelPriceWindow(now,calendar,null,config.maxPrice.fuel,effectiveConfig.maxPrice.fuel);
 const report:{phase:'pre'|'post';dryRun:boolean;enabled:boolean;entries:any[];halted:boolean;adaptive:any;forecast:any;fuelPriceWindow:FuelPriceWindow}={phase,dryRun,enabled:config.enabled,entries:[],halted:false,adaptive,forecast,fuelPriceWindow:initialWindow};
 const save=async()=>{
  const name=post?'supply-post-report':'supply-report';
  const file=join(directory,name+'.json');await writeFile(file+'.tmp',JSON.stringify(report,null,2)+'\n');await rename(file+'.tmp',file);
  await writeFile(join(directory,name+'.md'),['# Combustivel e CO2 — '+(post?'reposicao apos decolagens':'abastecimento inicial'),'',`Simulacao: ${dryRun}; habilitado: ${config.enabled}.`,'',
   '| Recurso | Preco / 1.000 | Teto efetivo inclusivo | Politica | Quantidade | Resultado |','| --- | --- | --- | --- | --- | --- |',
   ...report.entries.map(e=>`| ${e.kind} | ${e.before?.pricePer1000??'—'} | ${effectiveConfig.maxPrice[e.kind as Commodity]} | ${adaptive[e.kind as Commodity].source} (${adaptive[e.kind as Commodity].samples} amostras) | ${e.plan?.quantity??0} | ${e.status}: ${e.reason} |`),'',
   `Calendario de referencia: fuel=${forecast.fuel.status}, CO2=${forecast.co2.status}. O calendario nunca autoriza compra; exige preco live.`,
   '', '## Proxima janela de combustivel (referencia nao confirmada)', '',
   `Preco live: ${report.fuelPriceWindow.currentPricePer1000??'n/d'} /1k; limite configurado: ${report.fuelPriceWindow.configuredMax}; teto efetivo: ${report.fuelPriceWindow.effectiveMax}.`,
   report.fuelPriceWindow.nextEligible
    ? `Proximo horario listado dentro do teto efetivo: ${report.fuelPriceWindow.nextEligible.localDate} ${report.fuelPriceWindow.nextEligible.localTime} (UTC-3), preco previsto ${report.fuelPriceWindow.nextEligible.pricePer1000}/1k, economia potencial ${report.fuelPriceWindow.nextEligible.savingVsCurrentPer1000??'n/d'} por 1k (${report.fuelPriceWindow.nextEligible.savingVsCurrentPercent??'n/d'}%).`
    : 'Nenhum horario listado abaixo do teto efetivo nas proximas 24 horas (ou calendario incompleto).',
   report.fuelPriceWindow.note,''].join('\n'));
 };
 await save();if(!config.enabled)return report;
 try {
  for(const kind of ['fuel','co2'] as const){
   const entry:any={kind,status:'reading',reason:'PENDING',before:null,plan:null};report.entries.push(entry);
   await save();
   if(post&&Date.now()>options.mutationDeadlineEpochMs!-45000){
    entry.status='skipped';entry.reason='POST_SUPPLY_TIME_BUDGET_EXHAUSTED';
    await save();continue;
   }
   await port.open(kind);entry.before=await port.snapshot(kind);
   if(kind==='fuel')report.fuelPriceWindow=fuelPriceWindow(new Date(),calendar,entry.before.pricePer1000,config.maxPrice.fuel,effectiveConfig.maxPrice.fuel);
   await save();
   if(!dryRun&&optimization.returnJournal){
    await appendSupplyObservation(optimization.returnJournal.directory,optimization.returnJournal.scope,env.GITHUB_RUN_ID||'',kind,entry.before);
    if(blockedSupplyKinds.has(kind)){
     const stillBlocked=(await readUnresolvedSupplyKinds(optimization.returnJournal.directory,optimization.returnJournal.scope,new Date())).has(kind);
     if(stillBlocked){entry.status='skipped';entry.reason='PERSISTED_UNCERTAIN_SUPPLY_BLOCK';await save();continue;}
     entry.reconciliation={status:'resolved',reason:'NEWER_VERIFIED_SUPPLY_SNAPSHOT',mutationAuthorized:false};
    }
   }
   const spentEarlier=post?(preReport.entries||[])
     .filter((e:any)=>e.kind===kind&&e.status==='purchased')
     .reduce((sum:number,e:any)=>sum+e.plan?.quantity,0):0;
   const originalCap=config.maxQuantity[kind];
   if(post&&originalCap>0&&(!Number.isSafeInteger(spentEarlier)||spentEarlier<0||spentEarlier>originalCap))
    throw Error('POST_SUPPLY_PRE_QUANTITY_INVALID');
   if(post&&originalCap>0&&spentEarlier>=originalCap){
    entry.status='skipped';entry.reason='RUN_QUANTITY_LIMIT_ALREADY_USED';
    await save();continue;
   }
   const availableCap=originalCap===0?0:originalCap-spentEarlier;
   const phaseConfig={...effectiveConfig,maxQuantity:{...effectiveConfig.maxQuantity,[kind]:availableCap}};
   entry.plan=planPurchase(entry.before,kind,phaseConfig);
   if(entry.plan.reason==='INVALID_DATA')throw Error('SUPPLY_DATA_INVALID');
   if(!entry.plan.quantity){entry.status='skipped';entry.reason=entry.plan.reason;await save();continue;}
   const quote=await port.quote(kind,entry.plan.quantity);
   entry.quotedCost=quote.total;entry.discountPercent=quote.discountPercent;
   const fresh=await port.snapshot(kind);
   const expectedCost=entry.before.pricePer1000*entry.plan.quantity/1000*(1-quote.discountPercent/100);
   if(JSON.stringify(fresh)!==JSON.stringify(entry.before)||entry.quotedCost<=0||entry.quotedCost>entry.plan.budget||
     entry.quotedCost>entry.plan.estimatedCost||Math.abs(entry.quotedCost-expectedCost)>=1)throw Error('SUPPLY_QUOTE_CHANGED_OR_OVER_BUDGET');
   entry.reason='PRICE_AND_BUDGET_ACCEPTED';
   if(dryRun){entry.status='would_buy';await save();continue;}
   if(post&&Date.now()>options.mutationDeadlineEpochMs!-45000){
    entry.status='skipped';entry.reason='POST_SUPPLY_TIME_BUDGET_EXHAUSTED';
    await save();continue;
   }
   entry.status='attempting';await save();
   try{
    entry.after=await port.purchase(kind,entry.plan.quantity,entry.before,quote);
   }catch(error){
    if(error instanceof SupplyPreMutationError&&error.code==='SUPPLY_PRICE_ROLLOVER'){
     entry.status='skipped';entry.reason='PRICE_ROLLOVER_BEFORE_PURCHASE';
     entry.diagnostic=await port.diagnostic(kind).catch(()=>null);
     await save();
     continue;
    }
    throw error;
   }
   entry.status='purchased';entry.reason='STOCK_AND_PAYMENT_CONFIRMED';await save();
  }
  await port.close();
 }catch(error){
  const raw=error instanceof Error?error.message:'UNCLASSIFIED';
  const code=error instanceof SupplyPreMutationError?error.code:(/^[A-Z0-9_:-]{1,120}$/.test(raw)?raw:'UNCLASSIFIED');
  const preMutation=error instanceof SupplyPreMutationError;
  const entry=report.entries.at(-1);if(entry){
   if(entry.status!=='attempting'||preMutation)entry.diagnostic=await port.diagnostic(entry.kind).catch(()=>null);
   entry.reason=preMutation?'READ_OR_VALIDATION_FAILED:'+code:
     entry.status==='attempting'?'OUTCOME_UNKNOWN_NO_RETRY:'+code:'READ_OR_VALIDATION_FAILED:'+code;
   entry.status=preMutation?'unavailable':entry.status==='attempting'?'unknown':'unavailable';
  }
  report.halted=true;await save();
  if(entry?.status==='unknown'&&!dryRun&&optimization.returnJournal){
   try{await appendUncertainSupplyOperation(optimization.returnJournal.directory,optimization.returnJournal.scope,env.GITHUB_RUN_ID||'',entry);}
   catch{entry.quarantinePersistence='failed';await save();throw Error('SUPPLY_UNKNOWN_QUARANTINE_PERSIST_FAILED_NO_RETRY');}
  }
  throw Error('SUPPLY_HALTED_SEE_REPORT_NO_RETRY:'+code);
 }
 console.log('[Supplies] '+JSON.stringify(report.entries.map(({kind,status,reason})=>({kind,status,reason}))));
 return report;
}
