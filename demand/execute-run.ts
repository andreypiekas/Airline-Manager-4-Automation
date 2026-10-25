export function hasIncompleteInitialDepartureCollection(report:ExecutionReport):boolean {
  return report.entries.some(e=>e.reason==='INITIAL_COLLECTION_INCOMPLETE');
}

/** A green workflow must not mask ready, demand-qualified flights blocked
 * solely because the fuel requirement could not be independently established.
 * Retain the safe HOLD and all persisted checkpoints; report an operational failure.
 */
export function hasUnverifiedFuelDeparture(report:ExecutionReport):boolean {
  return report.entries.some(e=>e.status==='held'&&e.reason==='FUEL_REQUIREMENT_UNVERIFIED'&&
    e.demand?.decision==='would_depart');
}

import { Page } from '@playwright/test';
import { mkdir,open,rename,writeFile,readFile,appendFile } from 'node:fs/promises';
import { join } from 'node:path';
import { readDemandConfig } from './config';
import { DemandConfig, CollectionResult } from './types';
import { IndividualDepartureExecutor, ExecutionReport } from './executor';
import { PlaywrightDeparturePort } from './departure-port';
import { inspectFirstPageReadOnly } from './rolling-first-page';
import { verifiedFirstPagePriorityKeys } from './rolling-first-page-priority';
import { MUTATION_COMPLETION_RESERVE_MS } from '../utils/run-time-budget';
import { optimizationConfig } from '../optimization/report';
import { appendConfirmedDepartures,appendDemandHoldObservations,appendUncertainDepartures,readUnresolvedDepartureKeys } from '../optimization/return-journal';
import { loadAdaptiveDemandThresholds } from './adaptive-threshold';
import { hasDepartureBudgetStarvation } from '../utils/run-time-budget';
import { DepartureTerminalCheckpoints } from './terminal-checkpoints';
import {readPendingDeferredDispatchKeys,checkpointDeferredDispatchQueue} from '../optimization/deferred-dispatch';

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
  const rawMax=(env.DEMAND_MAX_DEPARTURES_PER_RUN||'1').trim();
  const maxDepartures: number | 'all'=rawMax==='all'?'all':Number(rawMax);
  if(maxDepartures!=='all'&&(!/^[1-9]\d*$/.test(rawMax)||!Number.isSafeInteger(maxDepartures)||maxDepartures>100))
    throw Error('DEMAND_EXECUTION_LIMIT_INVALID');
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
  /** Fully verified Fleet inventory already collected in the same production run. */
  verifiedFleetSnapshot?:CollectionResult;
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
  const prioritizedDepartureKeys=!settings.dryRun&&optimization.returnJournal
    ?await readPendingDeferredDispatchKeys(optimization.returnJournal.directory,optimization.returnJournal.scope)
    :new Set<string>();
  console.log('[DepartureQueue] '+JSON.stringify({pendingFromPriorRuns:prioritizedDepartureKeys.size,mode:'PRIORITY_ONLY_FRESH_GATES_REQUIRED'}));
  await mkdir(directory,{recursive:true});
  // Exclusive marker survives repeated calls in this runner; Actions rejects every real rerun attempt.
  const marker=await open(join(directory,'individual-execution.started'),'wx');await marker.close();
  const safe=(s:string)=>s.replace(/[|\r\n<>]/g,' ');
  // Append a compact record for every state transition. A crash leaves the
  // latest atomic JSON checkpoint plus the already written transition journal.
  const savedTransitions=new Map<string,string>();
  const terminalCheckpoints=!settings.dryRun&&optimization.returnJournal
    ?new DepartureTerminalCheckpoints(optimization.returnJournal.directory,optimization.returnJournal.scope,env.GITHUB_RUN_ID||'')
    :null;
  const save=async(report:ExecutionReport)=>{
    const target=join(directory,'execution-report.json');
    await writeFile(target+'.tmp',JSON.stringify(report,null,2)+'\n');await rename(target+'.tmp',target);
    const transitions:string[]=[];
    for(const entry of report.entries){
      const key=entry.aircraftId+':'+entry.routeId;
      const fingerprint=JSON.stringify([entry.status,entry.reason,entry.actualOnboard,entry.estimatedGrossTicketRevenue]);
      if(savedTransitions.get(key)===fingerprint)continue;
      transitions.push(JSON.stringify({
        schemaVersion:1,recordedAt:new Date().toISOString(),
        aircraftId:entry.aircraftId,routeId:entry.routeId,registration:entry.registration,
        from:entry.from,to:entry.to,status:entry.status,reason:entry.reason,
        actualOnboard:entry.actualOnboard,estimatedGrossTicketRevenue:entry.estimatedGrossTicketRevenue??null
      }));
      savedTransitions.set(key,fingerprint);
    }
    if(transitions.length)await appendFile(join(directory,'execution-events.jsonl'),transitions.join('\n')+'\n');
    if(terminalCheckpoints)await terminalCheckpoints.flush(report.entries);
    if(report.completedAt&&!report.halted&&!hasIncompleteInitialDepartureCollection(report)&&
      !settings.dryRun&&optimization.returnJournal){
      // Store only time-deferred aircraft as cross-run priority hints.
      // A normal recheck clears matching old hints, but cannot authorize a
      // future click. The outer runner still reports time starvation as failure.
      const queue=await checkpointDeferredDispatchQueue(
        optimization.returnJournal.directory,optimization.returnJournal.scope,
        env.GITHUB_RUN_ID||'',report.entries
      );
      console.log('[DepartureQueue] '+JSON.stringify(queue));
      await writeFile(join(directory,'departure-queue.json'),JSON.stringify({
        schemaVersion:1,generatedAt:new Date().toISOString(),
        restoredPriorityKeys:prioritizedDepartureKeys.size,...queue
      },null,2)+'\n');
    }
    // The full human-readable report is derived once after processing, rather
    // than recreated at each pre-click and post-click checkpoint.
    if(!report.completedAt&&!report.halted)return;
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
  // On a previously COMPLETE same-run inventory, prefer currently visible
  // first-page ready targets. The page is only a scheduling hint: after this,
  // the original port.collect/prepare/depart/confirm safety gates are unchanged.
  let firstPageReadyPriorityKeys:ReadonlySet<string>=new Set<string>();
  const completeEarlier=prerequisites.verifiedFleetSnapshot?.complete===true;
  const readyEarlier=prerequisites.verifiedFleetSnapshot?.aircraft.some(a=>a.state==='ready')===true;
  if(!settings.dryRun&&completeEarlier&&readyEarlier&&env.DEMAND_FIRST_PAGE_PRIORITY!=='false'&&
     (settings.mutationDeadlineEpochMs===undefined ||
      Date.now()+MUTATION_COMPLETION_RESERVE_MS+30_000<settings.mutationDeadlineEpochMs)){
    try{
      const window=await inspectFirstPageReadOnly(page,3500);
      firstPageReadyPriorityKeys=verifiedFirstPagePriorityKeys(
        prerequisites.verifiedFleetSnapshot,window
      );
      console.log('[DepartureFirstPagePriority] '+JSON.stringify({
        status:window.status,observed:window.visible,
        matchedReady:firstPageReadyPriorityKeys.size,
        mutationAuthorized:false
      }));
    }catch(error){
      if(error instanceof Error&&error.message==='INTERACTIVE_CHALLENGE_DETECTED_STOP')throw error;
      console.warn('[DepartureFirstPagePriority] '+JSON.stringify({
        status:'UNAVAILABLE',matchedReady:0,mutationAuthorized:false
      }));
    }
  }
  const departurePort=new PlaywrightDeparturePort(page,15000,settings.mutationDeadlineEpochMs,prerequisites.verifiedFleetSnapshot);
  const report=await new IndividualDepartureExecutor(
    departurePort,config,{...settings,
    blockedDepartureKeys,prioritizedDepartureKeys,firstPageReadyPriorityKeys,fuelHoldingLbsAtRunStart,
    campaignVerified:!campaignGateRequired||campaignGateVerified,
    postReroutePricingBlockedAircraftIds:prerequisites.postReroutePricingBlockedAircraftIds,
    currentRouteFuelEvidence:prerequisites.currentRouteFuelEvidence},save,adaptive).run();
  console.log('[IndividualDepartures] '+JSON.stringify(report.summary));
  const navigation=departurePort.navigationMetrics();
  console.log('[DepartureNavigation] '+JSON.stringify(navigation));
  await writeFile(join(directory,'departure-navigation.json'),JSON.stringify({
    schemaVersion:1,generatedAt:new Date().toISOString(),...navigation,
    departed:report.summary.departed,held:report.summary.held,
    totalEvaluated:report.summary.evaluated
  },null,2)+'\n');
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
  if(report.halted)throw Error('DEMAND_EXECUTION_HALTED_UNKNOWN_RESULT_NO_RETRY');
  if(!settings.dryRun&&hasDepartureBudgetStarvation(report.entries)){
    const deferred=report.entries.filter(e=>e.status==='held' &&
      (e.reason==='RUN_TIME_BUDGET_EXHAUSTED_BEFORE_EVALUATION'||
       e.reason==='RUN_TIME_BUDGET_EXHAUSTED_BEFORE_MUTATION')).length;
    console.error('[DepartureRuntime] '+JSON.stringify({
      status:'INCOMPLETE_DUE_TO_TIME_BUDGET',
      departed:report.summary.departed,heldByTime:deferred,
      message:'Relatorio persistido; acoes confirmadas nao serao repetidas nesta run.'
    }));
    throw Error('DEMAND_EXECUTION_INCOMPLETE_TIME_BUDGET');
  }
  if(!settings.dryRun&&hasUnverifiedFuelDeparture(report)){
    const heldByFuel=report.entries.filter(e=>e.status==='held'&&
      e.reason==='FUEL_REQUIREMENT_UNVERIFIED').length;
    console.error('[DepartureFuel] '+JSON.stringify({
      status:'INCOMPLETE_DUE_TO_UNVERIFIED_FUEL_REQUIREMENT',
      departed:report.summary.departed,heldByFuel,
      message:'Sem consumo verificado: sem clique; relatorio preservado para diagnostico.'
    }));
    throw Error('DEMAND_EXECUTION_INCOMPLETE_FUEL_EVIDENCE');
  }
  // An unverified required campaign is a production HOLD, not a healthy
  // completed dispatch cycle. Preserve the report and never bypass the gate.
  if(!settings.dryRun&&hasCampaignVerificationBlock(report)){
    const heldByCampaign=report.entries.filter(e=>e.status==='held'&&
      e.reason==='CAMPAIGN_NOT_VERIFIED').length;
    console.error('[DepartureCampaign] '+JSON.stringify({
      status:'INCOMPLETE_DUE_TO_UNVERIFIED_REQUIRED_CAMPAIGN',
      departed:report.summary.departed,heldByCampaign,
      message:'Campanha exigida sem confirmacao fresca; nenhuma partida foi autorizada para essas aeronaves.'
    }));
    throw Error('DEMAND_EXECUTION_INCOMPLETE_CAMPAIGN_EVIDENCE');
  }
  return report;
}

export function hasCampaignVerificationBlock(report:Pick<ExecutionReport,'entries'>):boolean {
  return report.entries.some(e=>e.status==='held'&&e.reason==='CAMPAIGN_NOT_VERIFIED');
}
