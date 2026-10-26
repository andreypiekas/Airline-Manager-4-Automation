import { collectCandidateData, writeCandidateDataReport, researchConfig, researchFleetCandidates, writeRouteResearchReport } from '../optimization/research-reader';
import { writeOccupancyAudit } from './occupancy-audit';
import { writeReferenceReport } from '../optimization/reference-report';
import { buildAircraftRouteReview, writeAircraftRouteReview } from '../optimization/aircraft-route-review';
import { RouteReview } from '../optimization/route-optimizer';
import { writeFleetObservations } from '../optimization/fleet-observations';
import { analyzeOptimizationWithJournal, optimizationConfig, writeOptimizationReport } from '../optimization/report';
import { discoverOwnedAirlineBases } from '../optimization/owned-airline-bases';
import { Page } from '@playwright/test';
import { readDemandConfig } from './config';
import { DemandManager } from './manager';
import { collectFleetWithFreshRetry } from './reader';
import { inspectFirstPageReadOnly } from './rolling-first-page';
import { inspectIndividualFirstPage } from './rolling-individual-preflight';
import { observeRollingFirstPage } from './rolling-first-page-cycle';
import { recoverMissingFlightHistories } from './history-recovery';
import { writeDemandReport } from './report';
import { DemandConfig, DemandReport } from './types';
import { loadAdaptiveDemandThresholds } from './adaptive-threshold';
import { appendFlightHistoryAnchors, appendObservedArrivals, appendResolvedUncertainDepartures, readFlightHistoryContinuityDiagnostics, readFlightHistoryStitchDiagnostics, readLiveAnchoredFlightHistoryStitchDiagnostics } from '../optimization/return-journal';
import { mkdir, writeFile } from 'node:fs/promises';

export async function runDemandSimulationDetailed(page: Page, config: DemandConfig = readDemandConfig(), reviews: Record<string, RouteReview> = {}, options: { collectionRetryDeadlineEpochMs?: number } = {}) {
  const configuredOptimization = optimizationConfig();
  const ownedBases = await discoverOwnedAirlineBases(page, configuredOptimization.airlineBases);
  const optimization = {...configuredOptimization, airlineBases: ownedBases.effectiveBases};
  const research = researchConfig();
  const collection = await collectFleetWithFreshRetry(page, 10000, true, options.collectionRetryDeadlineEpochMs);
  // Avoid spending the remaining mutation window on global history,
  // research and pricing when native Fleet has already proved incomplete.
  // A separate individual executor must re-read every eligible target;
  // none of the partial global identities authorize any click.
  const off=(raw:string|undefined)=>['false','0','off','no'].includes((raw||'').trim().toLowerCase());
  if(!collection.complete&&!config.dryRun&&!off(process.env.ENABLE_DEPART)&&
     !off(process.env.ENABLE_ROLLING_INDIVIDUAL_FALLBACK)){
    await mkdir('test-results/demand',{recursive:true});
    await writeFile('test-results/demand/global-fleet-fallback.json',JSON.stringify({
      schemaVersion:1,mode:'native-individual-fallback',
      globalComplete:false,observed:collection.aircraft.length,
      expected:collection.expectedRoutes,
      globalMutationsAuthorized:false,individualTargetChecksRequired:true,
      generatedAt:new Date().toISOString()
    },null,2)+'\\n');
    console.warn('[DemandCollection] '+JSON.stringify({
      observed:collection.aircraft.length,expected:collection.expectedRoutes,
      action:'SAFE_INDIVIDUAL_FALLBACK',globalComplete:false
    }));
    throw Error('FLEET_INCOMPLETE_INDIVIDUAL_FALLBACK');
  }
  // Progressive first-page diagnostic runs ONLY after a failed full
  // inventory. It never turns a partial collection into authorization.
  if (!collection.complete && process.env.DEMAND_FIRST_PAGE_PILOT !== 'false') {
    try {
      const rolling = await observeRollingFirstPage(
        () => inspectFirstPageReadOnly(page, 5000),
        {
          maxWindows:3,
          maxConsecutiveWithoutNewReady:2,
          deadlineEpochMs:options.collectionRetryDeadlineEpochMs,
          // A bounded pause permits natural arrivals to alter the native page.
          // Never use a stale Fleet cursor: every iteration reopens page one.
          pause:() => page.waitForTimeout(350)
        }
      );
      const last = rolling.windows[rolling.windows.length-1];
      console.warn('[FirstPagePilot] ' + JSON.stringify({
        status:last?.status ?? 'TIME_BUDGET',
        routeTotal:last?.routeTotal ?? null,
        visible:last?.visible ?? 0,
        ready:last?.ready ?? 0,
        snapshots:rolling.windows.length,
        uniqueObserved:rolling.totalKnownAircraft,
        newlyReady:rolling.totalNewReady,
        stopReason:rolling.stopReason,
        mutationAuthorized:false
      }));
      await mkdir('test-results/demand',{recursive:true});
      await writeFile('test-results/demand/first-page-pilot.json',JSON.stringify({
        schemaVersion:1,
        mode:'read-only',
        generatedAt:new Date().toISOString(),
        status:last?.status ?? 'TIME_BUDGET',
        routeTotal:last?.routeTotal ?? null,
        visible:last?.visible ?? 0,
        ready:last?.ready ?? 0,
        mutationAuthorized:false,
        rolling
      },null,2)+'\n');
    } catch (error) {
      // A passive observation is never allowed to swallow a CAPTCHA/challenge.
      if (error instanceof Error && error.message === 'INTERACTIVE_CHALLENGE_DETECTED_STOP') throw error;
      console.warn('[FirstPagePilot] ' + JSON.stringify({
        status:'UNAVAILABLE',mutationAuthorized:false
      }));
    }
  }
  // A failed global Fleet inventory must not block read-only investigation
  // of individual ready targets. This bounded pilot NEVER authorizes Depart;
  // a future executor will need separate fresh Fuel, campaign, demand-pool,
  // terminal checkpoint, response and countdown/onboard confirmation gates.
  if(!collection.complete && process.env.DEMAND_INDIVIDUAL_PREFLIGHT!=='false'){
    try{
      const pilot=await inspectIndividualFirstPage(page,{
        timeout:3500,maxCandidates:2,
        deadlineEpochMs:options.collectionRetryDeadlineEpochMs
      });
      const summary={
        schemaVersion:1,mode:pilot.mode,window:pilot.window,
        readyCandidates:pilot.readyCandidates,inspected:pilot.inspected,
        verified:pilot.verified,holds:pilot.holds,mutationAuthorized:false
      };
      console.warn('[IndividualPreflight] '+JSON.stringify(summary));
      await mkdir('test-results/demand',{recursive:true});
      await writeFile('test-results/demand/individual-preflight.json',
        JSON.stringify({...summary,validatedTargetKeys:pilot.verifiedAircraft.map(a=>({
          aircraftId:a.aircraftId,routeId:a.routeId,
          registration:a.registration,observedAt:a.observedAt
        }))},null,2)+'\\n');
    }catch(error){
      if(error instanceof Error&&error.message==='INTERACTIVE_CHALLENGE_DETECTED_STOP')throw error;
      console.warn('[IndividualPreflight] '+JSON.stringify({
        schemaVersion:1,mode:'read-only-individual',status:'UNAVAILABLE',mutationAuthorized:false
      }));
    }
  }
  const recoveredHistory=await recoverMissingFlightHistories(page,collection,10000,options.collectionRetryDeadlineEpochMs);
  await mkdir('test-results/demand',{recursive:true});
  await writeFile('test-results/demand/flight-history-recovery.json',JSON.stringify(recoveredHistory,null,2)+'\n');
  console.log('[FlightHistoryRecovery] '+JSON.stringify(recoveredHistory));
  if(optimization.returnJournal){
    const resolvedDepartures=await appendResolvedUncertainDepartures(optimization.returnJournal.directory,optimization.returnJournal.scope,collection);
    if(resolvedDepartures)console.log('[History] Quarentenas de departure reconciliadas por estado live: '+resolvedDepartures+'.');
    const arrivals=await appendObservedArrivals(optimization.returnJournal.directory,optimization.returnJournal.scope,collection);
    if(arrivals)console.log('[History] Chegadas observadas acrescentadas: '+arrivals+'.');
  }
  const adaptive=optimization.returnJournal?await loadAdaptiveDemandThresholds(optimization.returnJournal.directory,optimization.returnJournal.scope,config.minPercentage):new Map();
  const analysisNow=new Date();
  const report = new DemandManager({...config,dryRun:true},adaptive).analyze(collection,analysisNow);
  await writeDemandReport(report);
  await writeOccupancyAudit(collection, config);
  await writeFleetObservations(collection, optimization.aircraftOrigins, 'test-results/demand', config.maxAgeSeconds, optimization.airlineBases);
  await writeReferenceReport(collection, optimization);
  await writeOptimizationReport(await analyzeOptimizationWithJournal(collection, optimization, reviews));
  const researchReport=await researchFleetCandidates(page, collection, optimization, research, analysisNow, report);
  await writeRouteResearchReport(researchReport);
  const liveStitches=optimization.returnJournal
    ? await readLiveAnchoredFlightHistoryStitchDiagnostics(optimization.returnJournal.directory,optimization.returnJournal.scope,collection.aircraft)
    : [];
  const candidateData=await collectCandidateData(page,collection,researchReport,optimization.minOccupancy,liveStitches,report);
  await writeCandidateDataReport(candidateData);
  const routeReview=buildAircraftRouteReview({collection,research:researchReport,analysis:candidateData});
  await writeAircraftRouteReview(routeReview);
  console.log('[AircraftRouteReview] '+JSON.stringify(routeReview.summary));
  if(optimization.returnJournal&&/^[1-9]\d*$/.test(process.env.GITHUB_RUN_ID||'')){
    const anchors=await appendFlightHistoryAnchors(optimization.returnJournal.directory,optimization.returnJournal.scope,process.env.GITHUB_RUN_ID!,collection,candidateData.flightHistoryCoverage);
    console.log('[History] Ancoras compactas de Flight History acrescentadas: '+anchors+'.');
    const continuity=await readFlightHistoryContinuityDiagnostics(optimization.returnJournal.directory,optimization.returnJournal.scope);
    await writeFile('test-results/demand/flight-history-continuity.json',JSON.stringify({schemaVersion:1,generatedAt:new Date().toISOString(),diagnostics:continuity},null,2)+'\n');
    await writeFile('test-results/demand/flight-history-continuity.md',['# Continuidade persistente do Flight History','',...(continuity.length?continuity.map(x=>`- ${x.aircraftId}: ${x.status}; sobreposicao ${x.overlapRows}; delta de ciclos ${x.cycleDelta??'n/d'}; motivo ${x.reason}.`):['Nenhum par de snapshots persistidos disponivel neste run.']),'','_Somente evidencia de continuidade. comparisonReady e mutationAuthorized permanecem false._',''].join('\n'));
    const stitches=await readFlightHistoryStitchDiagnostics(optimization.returnJournal.directory,optimization.returnJournal.scope);
    await writeFile('test-results/demand/flight-history-stitch.json',JSON.stringify({schemaVersion:1,generatedAt:new Date().toISOString(),diagnostics:stitches},null,2)+'\n');
    await writeFile('test-results/demand/flight-history-stitch.md',['# Stitched Flight History persistente — diagnostico','',...(stitches.length?stitches.map(x=>`- ${x.aircraftId}: ${x.status}; anchors usados ${x.anchorsUsed}/${x.anchorsAvailable}; links verificados ${x.linksVerified}; linhas compostas ${x.rowsStitched}; idade inferior da linha mais antiga ${x.oldestAgeLowerMinutes??'n/d'} min; motivo ${x.reason}${x.stoppedReason?'; limite '+x.stoppedReason:''}.`):['Nenhuma cadeia persistida disponivel neste run.']),'','_Diagnostico somente leitura. Ainda nao altera remaining demand; comparisonReady e mutationAuthorized permanecem false._',''].join('\n'));
    await writeFile('test-results/demand/flight-history-live-stitch.json',JSON.stringify({schemaVersion:1,generatedAt:new Date().toISOString(),diagnostics:liveStitches},null,2)+'\n');
    await writeFile('test-results/demand/flight-history-live-stitch.md',['# Stitched Flight History ancorado no snapshot live — diagnostico','',...(liveStitches.length?liveStitches.map(x=>`- ${x.aircraftId}: ${x.status}; live ${x.liveAnchorVerified?'verificado':'indisponivel'}; anchors persistidos ${x.persistedAnchorsAvailable}; usados ${x.anchorsUsed}; links ${x.linksVerified}; linhas ${x.rowsStitched}; idade inferior mais antiga ${x.oldestAgeLowerMinutes??'n/d'} min; motivo ${x.reason}${x.stoppedReason?'; limite '+x.stoppedReason:''}.`):['Nenhuma aeronave disponivel neste run.']),'','_Snapshot live obrigatorio. Cadeias verificadas podem complementar somente a cobertura historica do ledger de demanda; o stitch continua com comparisonReady=false e mutationAuthorized=false e nunca autoriza reroute isoladamente._',''].join('\n'));
  }
  if(!candidateData.uiRestored)throw new Error('[Demand] Painel nao restaurado apos consulta; nenhuma operacao autorizada.');
  if (!report.collectionComplete) {
    // Structured, sanitized evidence in Actions logs, without DOM/URLs or session data.
    console.warn('[DemandCollection] '+JSON.stringify({
      observed:collection.aircraft.length,
      expected:collection.expectedRoutes,
      warnings:collection.warnings.filter(value=>/^[A-Z0-9_:/.]{1,100}$/.test(value)).slice(0,15)
    }));
    throw new Error('[Demand] Coleta incompleta. Relatorio salvo; nenhuma decolagem autorizada.');
  }
  return {report,collection,researchReport,candidateData,optimization,ownedBases};
}

export type DemandSimulationContext=Awaited<ReturnType<typeof runDemandSimulationDetailed>>;

export async function runDemandSimulation(
  page: Page,
  config: DemandConfig = readDemandConfig(),
  reviews: Record<string, RouteReview> = {}
): Promise<DemandReport> {
  return (await runDemandSimulationDetailed(page,config,reviews)).report;
}
