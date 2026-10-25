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
  // Passive diagnostic only, enabled on incomplete collections unless explicitly disabled.
  // A first-page window is NEVER a substitute for a
  // complete Fleet collection and cannot authorize departures, pricing or reroutes.
  if (!collection.complete && process.env.DEMAND_FIRST_PAGE_PILOT !== 'false') {
    try {
      const window = await inspectFirstPageReadOnly(page, 5000);
      console.warn('[FirstPagePilot] ' + JSON.stringify({
        status:window.status,routeTotal:window.routeTotal,
        visible:window.visible,ready:window.ready,mutationAuthorized:false
      }));
      await mkdir('test-results/demand',{recursive:true});
      await writeFile('test-results/demand/first-page-pilot.json',JSON.stringify({
        schemaVersion:1,mode:'read-only',generatedAt:new Date().toISOString(),
        status:window.status,routeTotal:window.routeTotal,visible:window.visible,
        ready:window.ready,mutationAuthorized:false
      },null,2)+'\n');
    } catch (error) {
      // The diagnostic must never hide a CAPTCHA/challenge from the main
      // production safety gate. Other read failures are passive only.
      if (error instanceof Error && error.message === 'INTERACTIVE_CHALLENGE_DETECTED_STOP') throw error;
      console.warn('[FirstPagePilot] ' + JSON.stringify({
        status:'UNAVAILABLE',mutationAuthorized:false
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
