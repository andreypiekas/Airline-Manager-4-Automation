export function hasIncompleteInitialDepartureCollection(report:ExecutionReport):boolean {
  return report.entries.some(e=>e.reason==='INITIAL_COLLECTION_INCOMPLETE');
}

import { Page } from '@playwright/test';
import { mkdir,open,rename,writeFile,readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { readDemandConfig } from './config';
import { DemandConfig } from './types';
import { IndividualDepartureExecutor, ExecutionReport } from './executor';
import { PlaywrightDeparturePort } from './departure-port';
import { optimizationConfig } from '../optimization/report';
import { appendConfirmedDepartures,appendDemandHoldObservations,appendUncertainDepartures,readUnresolvedDepartureKeys } from '../optimization/return-journal';
import { loadAdaptiveDemandThresholds } from './adaptive-threshold';
import { hasDepartureBudgetStarvation } from '../utils/run-time-budget';

async function verifiedFuelHoldingFromRun(directory:string):Promise<number|undefined>{
  try{
    const report=JSON.parse(await readFile(join(directory,'supply-report.json'),'utf8'));
    const fuel=(report?.entries||[]).find((e:any)=>e?.kind==='fuel');
    if(!fuel||fuel.status==='unknown'||fuel.status==='unavailable')return undefined;
    const snapshot=fuel.status==='purchased'?fuel.after:fuel.before;
    const holding=snapshot?.holding;
    return Number.isSafeInteger(holding)&&holding>=0?holding:undefined;
  }catch{return undefined;}
}

export function executionEnvironment(config:DemandConfig,env:NodeJS.ProcessEnv=process.env){
  const maxDepartures=Number(env.DEMAND_MAX_DEPARTURES_PER_RUN||'1');
  if(!Number.isSafeInteger(maxDepartures)||maxDepartures<1||maxDepartures>20)throw Error('DEMAND_EXECUTION_LIMIT_INVALID');
  if(!config.enabled||!config.failSafe)throw Error('DEMAND_EXECUTION_DISABLED');
  if(!config.dryRun&&(config.poolScope!=='airport-pair'||env.DEMAND_EXECUTION_ACK!=='individual-return-legs-v1'||env.GITHUB_ACTIONS!=='true'||
    !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(env.GITHUB_REPOSITORY||'')||!/^[1-9]\d*$/.test(env.GITHUB_RUN_ID||'')||
    env.GITHUB_RUN_ATTEMPT!=='1'))throw Error('DEMAND_REAL_EXECUTION_CONTEXT_INVALID_OR_RERUN');
  const rawDeadline=(env.DEMAND_EXECUTION_MUTATION_DEADLINE_EPOCH_MS||'').trim();
  const mutationDeadlineEpochMs=rawDeadline?Number(rawDeadline):undefined;
  if(mutationDeadlineEpochMs!==undefined&&(!Number.isSafeInteger(mutationDeadlineEpochMs)||mutationDeadlineEpochMs<=0))throw Error('DEMAND_EXECUTION_DEADLINE_INVALID');
  return {dryRun:config.dryRun,maxDepartures,mutationDeadlineEpochMs};
}
export interface DemandExecutionPrerequisites {
  postReroutePricingBlockedAircraftIds?:ReadonlySet<string>;
  currentRouteFuelEvidence?:ReadonlyMap<string,{
    aircraftId:string;routeId:string;from:string;to:string;fuelLbs:number;observedAt:string;
  }>;
}

export async function runDemandExecution(
  page:Page,
  config=readDemandConfig(),
  env:NodeJS.ProcessEnv=process.env,
  directory='test-results/demand',
  prerequisites:DemandExecutionPrerequisites={}
){
  const settings=executionEnvironment(config,env),optimization=optimizationConfig(env);
  const blockedDepartureKeys=optimization.returnJournal?await readUnresolvedDepartureKeys(optimization.returnJournal.directory,optimization.returnJournal.scope):new Set<string>();
  await mkdir(directory,{recursive:true});
  // Exclusive marker survives repeated calls in this runner; Actions rejects every real rerun attempt.
  const marker=await open(join(directory,'individual-execution.started'),'wx');await marker.close();
  const safe=(s:string)=>s.replace(/[|\r\n<>]/g,' ');
  const save=async(report:ExecutionReport)=>{
    const target=join(directory,'execution-report.json');
    await writeFile(target+'.tmp',JSON.stringify(report,null,2)+'\n');await rename(target+'.tmp',target);
    await writeFile(join(directory,'execution-report.md'),[
      `# Decolagens individuais — ${report.dryRun?'simulacao':'execucao real'}`,'',
      `Escopo: qualquer aeronave pronta em uma rota existente, independentemente do aeroporto/base atual. Avaliadas: ${report.summary.evaluated}; decolagens confirmadas: ${report.summary.departed}; simuladas: ${report.summary.simulated}; retidas: ${report.summary.held}; resultado incerto: ${report.summary.unknown}.`,'',
      '| Aeronave | Trecho | Estado | Motivo |','| --- | --- | --- | --- |',
      ...report.entries.map(e=>`| ${safe(e.registration)} | ${safe(e.from)} → ${safe(e.to)} | ${e.status} | ${safe(e.reason)} |`),'',
      'A cobertura por demanda nao e previsao de ocupacao. Embarque observado consta no JSON apos a decolagem.',
      'Uma aeronave pronta pode decolar pela rota atual em qualquer aeroporto quando identidade, controle nativo, demanda fresca e demais gates estiverem validados. Bases continuam sendo usadas apenas por funcoes que realmente dependem de hub, como route review/reroute. Rotas e tarifas continuam sem alteracoes nesta fase.',''
    ].join('\n'));
  };
  const adaptive=optimization.returnJournal?await loadAdaptiveDemandThresholds(optimization.returnJournal.directory,optimization.returnJournal.scope,config.minPercentage):new Map();
  const fuelHoldingLbsAtRunStart=!settings.dryRun?await verifiedFuelHoldingFromRun(directory):undefined;
  const campaignGateRequiredRaw=(env.CAMPAIGN_GATE_REQUIRED||'false').trim().toLowerCase();
  const campaignGateVerifiedRaw=(env.CAMPAIGN_GATE_VERIFIED||'false').trim().toLowerCase();
  if(!['true','false'].includes(campaignGateRequiredRaw)||!['true','false'].includes(campaignGateVerifiedRaw))throw Error('CAMPAIGN_GATE_INVALID');
  const campaignGateRequired=campaignGateRequiredRaw==='true';
  const campaignGateVerified=campaignGateVerifiedRaw==='true';
  const report=await new IndividualDepartureExecutor(
    new PlaywrightDeparturePort(page,15000,settings.mutationDeadlineEpochMs),config,{...settings,
    blockedDepartureKeys,fuelHoldingLbsAtRunStart,
    campaignVerified:!campaignGateRequired||campaignGateVerified,
    postReroutePricingBlockedAircraftIds:prerequisites.postReroutePricingBlockedAircraftIds,
    currentRouteFuelEvidence:prerequisites.currentRouteFuelEvidence},save,adaptive).run();
  console.log('[IndividualDepartures] '+JSON.stringify(report.summary));
  if(!settings.dryRun&&optimization.returnJournal){
    const held=await appendDemandHoldObservations(optimization.returnJournal.directory,optimization.returnJournal.scope,env.GITHUB_RUN_ID||'',report);
    console.log('[History] Holds de demanda observados acrescentados: '+held+'.');
    const added=await appendConfirmedDepartures(optimization.returnJournal.directory,optimization.returnJournal.scope,env.GITHUB_RUN_ID||'',report);
    console.log('[History] Decolagens confirmadas acrescentadas: '+added+'.');
    const uncertain=await appendUncertainDepartures(optimization.returnJournal.directory,optimization.returnJournal.scope,env.GITHUB_RUN_ID||'',report);
    console.log('[History] Tentativas incertas bloqueadas acrescentadas: '+uncertain+'.');
  }
  // An incomplete second Fleet scan can hold every eligible aircraft without
  // a click; this is an operational failure, not a successful empty cycle.
  if(hasIncompleteInitialDepartureCollection(report))
    throw Error('DEMAND_EXECUTION_INITIAL_COLLECTION_INCOMPLETE');
  // Green test status must not mask fleet-ready dispatches skipped only because
  // expensive read-only phases consumed the mutation completion window.
  if(!settings.dryRun&&hasDepartureBudgetStarvation(report.entries)){
    console.error('[DepartureRuntime] Zero decolagens confirmadas; ao menos uma aeronave foi bloqueada pelo limite de tempo.');
    throw Error('DEMAND_EXECUTION_BUDGET_EXHAUSTED_WITHOUT_DEPARTURE');
  }
  if(report.halted)throw Error('DEMAND_EXECUTION_HALTED_UNKNOWN_RESULT_NO_RETRY');
  return report;
}
