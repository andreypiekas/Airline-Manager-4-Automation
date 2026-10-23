import { openFleetList as openList, findFleetRoute as findRoute } from '../demand/navigation';
import { expect, Page } from '@playwright/test';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { AircraftSnapshot, CollectionResult, DemandReport } from '../demand/types';
import { DemandReader } from '../demand/reader';
import { OptimizationConfig } from './report';
import { fleetObservations } from './fleet-observations';
import { collectOpenRouteSuggestions, probeOpenRouteControl } from './suggestion-reader';
import { collectLiveCatalogQuotes, selectLiveCatalogQuoteTargets, type LiveCatalogQuoteScan } from './catalog-live-reader';
import { discoverCatalogRoutesForAircraft } from './reference-discovery';
import { ModelCostReadResult, ModelCostReference, readMarketPriceReferences, readModelCostReferenceResult } from './cost-reference-reader';
import { candidateDemandEvidence } from './candidate-evidence';
import { candidateReservationScenario, reservationConfig } from './reservations';
import { readAircraftMaintenanceReferences } from './maintenance-reader';
import { candidateCostScenarios, effectiveCostBudget } from './cost-budget';
import { emptyFinanceHistory, readFinanceHistoryReference } from './finance-reader';
import { screenCandidateEconomics } from './economic-screen';
import { buildCandidateRoundTripScreen } from './round-trip-screen';
import { aircraftReferenceByModel, AircraftCatalog, airportDistanceEvidence, airportRunwayEvidence, AirportCatalog, loadReference, RouteCatalog } from './reference-data';
import { CandidateQuote } from './quote-reader';
import { candidatePriorityReference, rankCandidatePriorities } from './candidate-priority';
import { compareKnownContribution, knownContributionLeg } from './route-known-contribution';
import { summarizeComparisonReadiness } from './route-readiness';
import { calibrateCo2FromFlightHistory } from './co2-calibration';
import { calibrateDemandLabelOnCurrentRoutes } from './demand-label-calibration';
import { calibrateDemandResetWindows, fleetHistoryCoverageDiagnostics } from './demand-reset-ledger';
import { crossCheckCommunityAircraftReference } from './model-reference-crosscheck';
import { readReputationDiagnostics } from './reputation-diagnostics';
import { inferGameModeEvidence } from './game-mode-evidence';
import { reverseLegEquivalentEvidence } from './reverse-leg-equivalence';
import { calibrateCurrentFareLoadFactor, transferCurrentFareLoadFactor } from './load-factor-calibration';
import { candidateLoadEnvelope, currentRouteLoadEnvelope } from './route-variable-profit';
import { compareRouteVariableCycles, conservativeSharedPairRemaining, currentRouteGrossRevenueCeiling, routeVariableRoundTripInterval } from './route-variable-cycle';
import { routeProfitModelEvidence } from './route-profit-model';
import { routeDailyPotential, rankDailyRouteScenarios } from './route-daily-potential';
import { planVariableRouteDecision, routeDecisionSetComparisonReady } from './route-decision';
import { validateReturnJournal, type Journal, type LiveAnchoredFlightHistoryStitchDiagnostic } from './return-journal';
import { dailyReviewDue } from './review-schedule';

export interface ResearchConfig { enabled: boolean; maxAircraft: number; maxSuggestions: number; catalogQueries?:number; timeout: number }
export function researchQueueRotation<T>(entries:readonly T[],now:Date,windowMinutes=30,stride=1){
  if(!Array.isArray(entries)||!Number.isFinite(now.getTime())||!Number.isSafeInteger(windowMinutes)||windowMinutes<1||windowMinutes>1440||
    !Number.isSafeInteger(stride)||stride<1||stride>10)
    throw new Error('RESEARCH_QUEUE_ROTATION_INVALID');
  if(!entries.length)return {entries:[] as T[],slot:0,offset:0,windowMinutes,stride};
  const slot=Math.floor(now.getTime()/(windowMinutes*60_000));
  // Rotate by the number of scheduled aircraft we can actually inspect in
  // this window. One-slot rotation used to recheck almost the same aircraft
  // every run (126 aircraft / 3 per run -> only one new aircraft per window).
  const offset=(slot*stride)%entries.length;
  return {entries:[...entries.slice(offset),...entries.slice(0,offset)],slot,offset,windowMinutes,stride};
}
export function researchConfig(env: NodeJS.ProcessEnv = process.env): ResearchConfig {
  const enabled = env.ENABLE_ROUTE_RESEARCH?.trim().toLowerCase() || 'false';
  if (!['true','false'].includes(enabled)) throw new Error('RESEARCH_CONFIG_INVALID');
  const bounded = (key: string, fallback: number, maximum: number) => {
    const value = Number(env[key]?.trim() || fallback);
    if (!Number.isSafeInteger(value) || value < 1 || value > maximum) throw new Error('RESEARCH_CONFIG_INVALID');
    return value;
  };
  return { enabled: enabled === 'true', maxAircraft: bounded('ROUTE_RESEARCH_MAX_AIRCRAFT',3,10),
    maxSuggestions: bounded('ROUTE_RESEARCH_MAX_SUGGESTIONS',5,10),
    catalogQueries: (()=>{const n=Number(env.ROUTE_RESEARCH_CATALOG_QUERIES?.trim()||'2');if(!Number.isSafeInteger(n)||n<0||n>5)throw new Error('RESEARCH_CONFIG_INVALID');return n;})(),
    timeout: 10000 };
}

/** Observation only: quotes are never converted into complete economic reviews. */
export async function researchFleetCandidates(page: Page, collection: CollectionResult, optimization: OptimizationConfig, config = researchConfig(), now = new Date(), demandReport:DemandReport|null=null) {
  // Validate injected configuration too, before any navigation.
  if (typeof config.enabled !== 'boolean' || !Number.isSafeInteger(config.maxAircraft) || config.maxAircraft < 1 || config.maxAircraft > 10 ||
    !Number.isSafeInteger(config.maxSuggestions) || config.maxSuggestions < 1 || config.maxSuggestions > 10 ||
    (config.catalogQueries!==undefined&&(!Number.isSafeInteger(config.catalogQueries)||config.catalogQueries<0||config.catalogQueries>5))||
    !Number.isSafeInteger(config.timeout) || config.timeout < 1 || config.timeout > 30000) throw new Error('RESEARCH_CONFIG_INVALID');
  if(!Number.isFinite(now.getTime()))throw new Error('RESEARCH_TIME_INVALID');
  const observations = fleetObservations(collection, optimization.aircraftOrigins, now, optimization.maxAgeSeconds, optimization.airlineBases);
  let catalogForLive:RouteCatalog|null=null, airportsForLive:AirportCatalog|null=null;
  if(config.enabled&&(config.catalogQueries??0)>0&&collection.complete){
    try{
      const routes=await loadReference<RouteCatalog>('routes.json');
      const airports=await loadReference<AirportCatalog>('airports.json');
      if(routes.schemaVersion===1&&Array.isArray(routes.routes)&&[1,2].includes(airports.schemaVersion)&&Array.isArray(airports.airports)){
        catalogForLive=routes;airportsForLive=airports;
      }
    }catch{/* Catalog quote discovery is optional; the native suggestion workflow remains usable. */}
  }
  let reviewJournal:Journal|null=null,reviewJournalAvailable=true;
  if(optimization.returnJournal){
    try{
      reviewJournal=validateReturnJournal(
        JSON.parse(await readFile(join(optimization.returnJournal.directory,'return-journal.json'),'utf8')),
        optimization.returnJournal.scope,now
      );
    }catch{reviewJournalAvailable=false;}
  }
  const demandByAircraft=new Map((demandReport?.decisions||[]).map(d=>[d.aircraftId,d] as const));
  const aircraft = observations.aircraft.map(a => {
    const demand=demandByAircraft.get(a.aircraftId);
    const demandTriggered=demand?.decision==='hold_insufficient'&&demand.routeId===a.routeId;
    const researchOrigin=demandTriggered?a.currentAirport:a.operationalOrigin;
    let status=!config.enabled || !optimization.routesEnabled ? 'disabled' : !a.detailsVerified ? 'data_unavailable' :
      a.state !== 'ready' ? 'pending_inflight' :
      !researchOrigin ? 'origin_unavailable' :
      demandTriggered ? 'queued_demand' :
      !a.operationalOrigin ? 'origin_unavailable' :
      a.currentAirport !== a.operationalOrigin ? 'pending_base_return' : 'queued';
    if((status==='queued'||status==='queued_demand')&&optimization.returnJournal&&!reviewJournalAvailable)status='journal_unavailable';
    else if(status==='queued'&&reviewJournal&&!dailyReviewDue(a.aircraftId,a.operationalOrigin,reviewJournal,now,optimization.reviewTimeZone))
      status='completed_today';
    return {
      aircraftId:a.aircraftId,registration:a.registration,origin:a.operationalOrigin,researchOrigin,routeId:a.routeId,status,
      trigger:demandTriggered?'demand_insufficient' as const:'scheduled_review' as const,
      demandOccupancyPercentage:demandTriggered?demand?.occupancyPercentage??null:null,
      result:null as Awaited<ReturnType<typeof collectOpenRouteSuggestions>> | null,
      catalogLive:null as LiveCatalogQuoteScan|null
    };
  });
  const demandQueued=aircraft.filter(a=>a.status==='queued_demand').sort((a,b)=>
    (a.demandOccupancyPercentage??Number.POSITIVE_INFINITY)-(b.demandOccupancyPercentage??Number.POSITIVE_INFINITY)||
    a.aircraftId.localeCompare(b.aircraftId)
  );
  const scheduledQueued=aircraft.filter(a=>a.status==='queued');
  const availableScheduledSlots=Math.max(1,config.maxAircraft-Math.min(demandQueued.length,config.maxAircraft));
  const rotation=researchQueueRotation(scheduledQueued,now,30,availableScheduledSlots);
  const prioritized=[...demandQueued,...rotation.entries];
  const report = {schemaVersion:4,generatedAt:now.toISOString(),dryRun:true,mutationAuthorized:false,
    candidatesComplete:false,comparisonReady:false,collectionComplete:collection.complete,config,uiRestored:true,
    queueRotation:{eligible:prioritized.length,demandTriggeredEligible:demandQueued.length,scheduledEligible:scheduledQueued.length,
      slot:rotation.slot,offset:rotation.offset,stride:rotation.stride,windowMinutes:rotation.windowMinutes},
    warnings:reviewJournalAvailable?[] as string[]:['RESEARCH_JOURNAL_UNAVAILABLE'],aircraft,
    diagnosticProbe:null as Awaited<ReturnType<typeof probeOpenRouteControl>> | null,
    diagnosticProbes:[] as Awaited<ReturnType<typeof probeOpenRouteControl>>[]};
  let attempted=0;
  for (const entry of prioritized) {
    if (attempted >= config.maxAircraft) {entry.status='deferred_limit';continue;}
    attempted++;
    try {
      await openList(page,config.timeout);
      const expected = collection.aircraft.find(a => a.aircraftId === entry.aircraftId)!;
      await findRoute(page,expected,config.timeout);
      const fresh = await new DemandReader(page,config.timeout).readReadyAircraftDetails(expected);
      if (!fresh.operational || !expected.operational || fresh.operational.rangeKm !== expected.operational.rangeKm || fresh.operational.minRunwayFt !== expected.operational.minRunwayFt ||
        !entry.researchOrigin || fresh.from!==entry.researchOrigin) throw new Error('RESEARCH_CONTEXT_CHANGED');
      const reroute = page.locator('#detailsAction').getByRole('button',{name:/Reroute$/});
      if (await reroute.count() !== 1 || !await reroute.isVisible() || !await reroute.isEnabled() ||
        !new RegExp(`^showFlightInfo\\(this,${fresh.aircraftId},\\d+,false,true\\);closePop\\(\\);$`).test(await reroute.getAttribute('onclick') || '')) throw new Error('RESEARCH_PLANNER_CONTROL_UNVERIFIED');
      await reroute.click({timeout:config.timeout});
      await page.locator('#flightInfoContainer #introSuggest').waitFor({state:'visible',timeout:config.timeout});
      entry.result = await collectOpenRouteSuggestions(page,fresh,entry.researchOrigin,config.maxSuggestions,config.timeout,optimization.minOccupancy);
      entry.status = entry.result.status;
      if(entry.status==='observed'&&catalogForLive&&airportsForLive&&(config.catalogQueries??0)>0){
        const prospects=discoverCatalogRoutesForAircraft(
          fresh,entry.researchOrigin,catalogForLive,airportsForLive,new Date(),optimization.maxAgeSeconds,100
        );
        const targets=selectLiveCatalogQuoteTargets(prospects,airportsForLive,
          [...entry.result.quotes,...entry.result.screenedOut],config.catalogQueries!);
        if(targets.length){
          entry.catalogLive=await collectLiveCatalogQuotes(page,fresh,entry.researchOrigin,
            targets,config.timeout,optimization.minOccupancy);
          // Even successful catalog probes cannot make a curated set globally complete.
          entry.result.quotes.push(...entry.catalogLive.quotes);
          entry.result.screenedOut.push(...entry.catalogLive.screenedOut);
          entry.result.warnings.push(...entry.catalogLive.warnings);
          entry.result.scanned+=entry.catalogLive.attempted;
          if(entry.catalogLive.stoppedEarly)entry.status='partial';
        }
      }
    } catch {entry.status='unavailable';report.warnings.push(`RESEARCH_UNAVAILABLE:${entry.aircraftId}`);}
    finally {
      try {await openList(page,config.timeout);}
      catch {report.uiRestored=false;report.warnings.push('RESEARCH_LIST_RESTORE_FAILED');}
    }
    if (!report.uiRestored) {
      for (const remaining of aircraft) if (remaining.status === 'queued') remaining.status='deferred_restore_failure';
      break;
    }
  }
  if(config.enabled&&optimization.routesEnabled&&report.uiRestored&&attempted===0){
    // Diagnostic-only fallback: inspect up to five ready aircraft that are away
    // from their confirmed base. These probes never become route candidates and
    // never authorize a mutation; they only broaden live UI evidence across
    // different aircraft/models while normal optimization remains base-only.
    const pending=aircraft.filter(a=>a.status==='pending_base_return').slice(0,5);
    for(const probeEntry of pending){
      const expected=collection.aircraft.find(a=>a.aircraftId===probeEntry.aircraftId);
      if(!expected)continue;
      try{
        await openList(page,config.timeout);
        await findRoute(page,expected,config.timeout);
        const fresh=await new DemandReader(page,config.timeout).readReadyAircraftDetails(expected);
        if(fresh.state!=='ready'||fresh.issue||fresh.aircraftId!==expected.aircraftId||fresh.registration!==expected.registration||
          fresh.routeId!==expected.routeId||fresh.from!==expected.from||!fresh.operational||!expected.operational||
          fresh.operational.rangeKm!==expected.operational.rangeKm||fresh.operational.minRunwayFt!==expected.operational.minRunwayFt)
          throw new Error('DIAGNOSTIC_CONTEXT_CHANGED');
        const reroute=page.locator('#detailsAction').getByRole('button',{name:/Reroute$/});
        const callback=await reroute.getAttribute('onclick')||'';
        const match=callback.match(/^showFlightInfo\(this,(\d+),(\d+),false,true\);closePop\(\);$/);
        if(await reroute.count()!==1||!await reroute.isVisible()||!await reroute.isEnabled()||!match||match[1]!==fresh.aircraftId)
          throw new Error('DIAGNOSTIC_PLANNER_CONTROL_UNVERIFIED');
        await reroute.click({timeout:config.timeout});
        await page.locator('#flightInfoContainer #introSuggest').waitFor({state:'visible',timeout:config.timeout});
        const probe=await probeOpenRouteControl(page,fresh,fresh.from,config.timeout);
        report.diagnosticProbes.push(probe);
        if(!report.diagnosticProbe)report.diagnosticProbe=probe;
      }catch{
        report.warnings.push('DIAGNOSTIC_ROUTE_CONTROL_UNAVAILABLE:'+probeEntry.aircraftId);
      }finally{
        try{await openList(page,config.timeout);}
        catch{
          report.uiRestored=false;
          report.warnings.push('DIAGNOSTIC_LIST_RESTORE_FAILED');
        }
      }
      if(!report.uiRestored)break;
    }
  }
  return report;
}

export async function writeRouteResearchReport(report: Awaited<ReturnType<typeof researchFleetCandidates>>, directory='test-results/demand') {
  await mkdir(directory,{recursive:true});
  await writeFile(join(directory,'route-research.json'),JSON.stringify(report,null,2)+'\n');
  const rows = report.aircraft.map(a => `- ${a.aircraftId}: ${a.status}; gatilho ${a.trigger}; origem de pesquisa ${a.researchOrigin ?? 'indisponivel'}; ocupacao que disparou pesquisa ${a.demandOccupancyPercentage===null?'n/d':a.demandOccupancyPercentage.toFixed(2)+'%'}; candidatos mantidos ${a.result?.quotes.length ?? 0}; consultas nativas/curadas examinadas ${a.result?.scanned ?? 0}; consultas adicionais catalogo ${a.catalogLive?.attempted ?? 0}, observadas ${a.catalogLive?.observed ?? 0}; descartadas por teto de ocupacao ${a.result?.screenedOut.length ?? 0}.`);
  const probeRows=report.diagnosticProbes.length?report.diagnosticProbes:(report.diagnosticProbe?[report.diagnosticProbe]:[]);
  const diagnostic=probeRows.length?[
    '',
    '## Sondas estruturais fora da base — somente leitura',
    '',
    ...probeRows.flatMap(probe=>[
      `- Aeronave ${probe.aircraftId} em ${probe.currentAirport}: ${probe.status}; etapa ${probe.stage}.`,
      ...(probe.observation?[
        `  - Trecho: ${probe.observation.from}–${probe.observation.to}; Create route validado ${probe.observation.routeMutationControl?.nativeClickReady?'sim':'nao'}.`,
        `  - Autoprice: ${probe.observation.autopriceFunctionEvidence?.observed?'observado':'indisponivel'}; transformacao ${probe.observation.autopriceFunctionEvidence?.fareTransformVerified?'verificada':'nao verificada'}; modelos VIP ${probe.observation.autopriceFunctionEvidence?.vipModelIds?.join(', ')||'nenhum'}; multiplicador ${probe.observation.autopriceFunctionEvidence?.vipMultiplier??'indisponivel'}.`,
        `  - Campos operacionais: ${probe.observation.quoteFieldDiagnostics.map(f=>[f.id||'',f.label||'',f.title||''].filter(Boolean).join(' ')).join(' || ')||'nenhum'}.`
      ]:[]),
      ...probe.warnings.map(w=>'  - '+w)
    ])
  ]:[];
  await writeFile(join(directory,'route-research.md'),['# Consulta de rotas — somente leitura','',...rows,...diagnostic,'',
    'Consultas adicionais curadas usam apenas a resposta nativa de leitura new_route_info.php, validada por aircraftId, airportId e origem/destino. Nao criam rotas.',
    'Mesmo apos ampliar candidatas, o catalogo nao e global. Demanda restante, custos completos e tarifas efetivas precisam ser confirmados. Nenhuma consulta isolada autoriza uma troca.',
    ...report.warnings.map(w => '- '+w),''].join('\n'));
}

/** Adds available sources without manufacturing a complete RouteReview. */
export async function collectCandidateData(
  page:Page,
  collection:CollectionResult,
  research:Awaited<ReturnType<typeof researchFleetCandidates>>,
  minCoveragePercent=80,
  liveStitches:readonly LiveAnchoredFlightHistoryStitchDiagnostic[]=[],
  demandReport:DemandReport|null=null
){
  const reservationsConfig=reservationConfig();
  const quotes=research.aircraft.flatMap(a=>a.result?.quotes||[]);
  const models:ModelCostReference[]=[];const warnings:string[]=[];
  const modelReads:ModelCostReadResult[]=[];
  const screeningNow=new Date();
  const freshAt=(stamp:string,at:Date)=>{const age=at.getTime()-Date.parse(stamp);return Number.isFinite(age)&&age>=0&&age<=reservationsConfig.maxAgeSeconds*1000;};
  const capacityFor=(quote:CandidateQuote,at:Date)=>{
    const aircraft=collection.aircraft.find(a=>a.aircraftId===quote.aircraftId);
    return collection.complete&&aircraft&&aircraft.registration===quote.registration&&aircraft.operational&&!aircraft.issue&&freshAt(aircraft.observedAt,at)?aircraft.capacity:null;
  };
  const screeningByQuote=new Map(quotes.map(quote=>[quote,screenCandidateEconomics(
    quote,capacityFor(quote,screeningNow),minCoveragePercent,screeningNow,reservationsConfig.maxAgeSeconds
  )] as const));
  const economicQuotes=quotes.filter(quote=>screeningByQuote.get(quote)?.demandStatus!=='cannot_meet_threshold');
  const screenedOutBeforeModelReference=quotes.length-economicQuotes.length;
  if(screenedOutBeforeModelReference)warnings.push(`SCREENED_OUT_BEFORE_MODEL_REFERENCE:${screenedOutBeforeModelReference}`);
  let routeCatalog:RouteCatalog|null=null;
  try {
    const loaded=await loadReference<RouteCatalog>('routes.json');
    if(loaded.schemaVersion!==1||!Array.isArray(loaded.routes))throw new Error();
    routeCatalog=loaded;
  } catch {warnings.push('ROUTE_REFERENCE_UNAVAILABLE');}
  let airportCatalog:AirportCatalog|null=null;
  try {
    const loaded=await loadReference<AirportCatalog>('airports.json');
    if(![1,2].includes(loaded.schemaVersion)||!Array.isArray(loaded.airports)||!loaded.source||!loaded.license)throw new Error();
    airportCatalog=loaded;
  } catch {warnings.push('AIRPORT_REFERENCE_UNAVAILABLE');}
  let aircraftCatalog:AircraftCatalog|null=null;
  try {
    const loaded=await loadReference<AircraftCatalog>('aircrafts.json');
    if(loaded.schemaVersion!==1||!Array.isArray(loaded.models)||!loaded.source||!loaded.license)throw new Error();
    aircraftCatalog=loaded;
  } catch {warnings.push('AIRCRAFT_REFERENCE_UNAVAILABLE');}
  let uiRestored=research.uiRestored;
  let demandLabelCalibration:Awaited<ReturnType<typeof calibrateDemandLabelOnCurrentRoutes>>={
    status:'unavailable',observedAt:new Date().toISOString(),samples:[],classification:'mixed_or_unknown',
    comparisonReady:false,mutationAuthorized:false,uiRestored:true,warnings:[]
  };
  let demandResetCalibration:ReturnType<typeof calibrateDemandResetWindows>={
    status:'unavailable',windows:[],resetAgeUpperBoundMinutes:null,upperBoundSources:[],warnings:[],comparisonReady:false,mutationAuthorized:false
  };
  let market:Awaited<ReturnType<typeof readMarketPriceReferences>>={fuel:null,co2:null,uiClosed:true,stage:'not_requested',warnings:[],unitLabels:[]};
  let maintenance:Awaited<ReturnType<typeof readAircraftMaintenanceReferences>>={status:'not_requested',stage:'not_requested',observedAt:new Date().toISOString(),complete:false,uiClosed:true,aircraft:[],warnings:[]};
  let financeHistory=emptyFinanceHistory();
  let reputation=await readReputationDiagnostics(page);
  // Market and maintenance sources must be validated even when no aircraft is eligible for research.
  if(research.config.enabled&&uiRestored){
    demandLabelCalibration=await calibrateDemandLabelOnCurrentRoutes(page,collection,airportCatalog,research.config.timeout,10);
    if(!demandLabelCalibration.uiRestored){uiRestored=false;warnings.push('DEMAND_LABEL_CALIBRATION_LIST_RESTORE_FAILED');}
    warnings.push(...demandLabelCalibration.warnings);
    demandResetCalibration=calibrateDemandResetWindows(collection,demandLabelCalibration);
    warnings.push(...demandResetCalibration.warnings);
    const ids=[...new Set(economicQuotes.flatMap(q=>q.autopriceReference?[q.autopriceReference.modelId]:[]))];
    if(ids.length>10)warnings.push('MODEL_REFERENCE_LIMIT');
    for(const id of ids.slice(0,10)){
      try {
        await openList(page,research.config.timeout);
        const read=await readModelCostReferenceResult(page,id,research.config.timeout);modelReads.push(read);
        const community=aircraftReferenceByModel(id,aircraftCatalog);
        if(read.reference){
          const cross=crossCheckCommunityAircraftReference(read.reference,community.status==='unique'?community.reference:null);
          models.push({
            ...read.reference,
            acquisitionCost:cross.verified?cross.acquisitionCost??undefined:undefined,
            communityCrossCheck:{
              verified:cross.verified,fieldsMatched:cross.fieldsMatched,fieldsConflicted:cross.fieldsConflicted,
              reason:cross.reason,acquisitionCost:cross.acquisitionCost
            }
          });
          if(cross.verified)warnings.push(`MODEL_REFERENCE_COMMUNITY_CROSSCHECKED:${id}`);
        } else {
          if(community.status==='unique'&&community.reference){
            models.push({
              modelId:id,modelName:community.reference.modelName,observedAt:new Date().toISOString(),
              aCheckPrice:community.reference.aCheckPrice,checkIntervalHours:community.reference.checkIntervalHours,
              acquisitionCost:community.reference.acquisitionCost,source:'community-reference',effectiveAircraftMaintenanceCost:null
            });
            warnings.push(`MODEL_REFERENCE_COMMUNITY_FALLBACK:${id}`);
          } else warnings.push(`MODEL_REFERENCE_${read.status.toUpperCase()}:${id}`);
        }
      }catch{modelReads.push({modelId:id,status:'unavailable',reference:null});warnings.push(`MODEL_REFERENCE_UNAVAILABLE:${id}`);}
      finally{try{await openList(page,research.config.timeout);}catch{uiRestored=false;warnings.push('COST_REFERENCE_LIST_RESTORE_FAILED');}}
      if(!uiRestored)break;
    }
    if(uiRestored){
      market=await readMarketPriceReferences(page,research.config.timeout);
      try{if(!market.uiClosed)throw new Error();await openList(page,research.config.timeout);}
      catch{uiRestored=false;warnings.push('MARKET_LIST_RESTORE_FAILED');}
    }
    if(uiRestored){
      maintenance=await readAircraftMaintenanceReferences(page,collection,research.config.timeout);
      try{if(!maintenance.uiClosed)throw new Error();await openList(page,research.config.timeout);}
      catch{uiRestored=false;warnings.push('MAINTENANCE_LIST_RESTORE_FAILED');}
    }
    if(uiRestored){
      financeHistory=await readFinanceHistoryReference(page,research.config.timeout);
      try{if(!financeHistory.uiClosed)throw new Error();await openList(page,research.config.timeout);}
      catch{uiRestored=false;warnings.push('FINANCE_LIST_RESTORE_FAILED');}
    }
  }
  const now=new Date();
  const demandHoldByAircraft=new Map(
    (demandReport?.collectionComplete===true?demandReport.decisions:[])
      .filter(d=>d.decision==='hold_insufficient'&&d.departureAuthorized===false)
      .map(d=>[d.aircraftId,d] as const)
  );
  const flightHistoryCoverage=fleetHistoryCoverageDiagnostics(collection,demandResetCalibration,liveStitches);
  const routeProfitModel=routeProfitModelEvidence();
  const fresh=(stamp:string)=>freshAt(stamp,now);
  const candidates=quotes.map(quote=>{
    const demand=candidateDemandEvidence(quote,collection,now,reservationsConfig.maxAgeSeconds,demandResetCalibration,liveStitches);
    const model=models.find(m=>m.modelId===quote.autopriceReference?.modelId)||null;
    const reservations=candidateReservationScenario(quote,collection,now,reservationsConfig,demandResetCalibration,liveStitches);
    const aircraft=collection.aircraft.find(a=>a.aircraftId===quote.aircraftId);
    const capacity=capacityFor(quote,now);
    const screening=screeningByQuote.get(quote)!;
    const airportDistance=airportDistanceEvidence(quote.from,quote.to,airportCatalog,quote.distanceKm,quote.airportId);
    const runwayEvidence=airportRunwayEvidence(quote.from,quote.to,aircraft?.operational?.minRunwayFt??NaN,airportCatalog);
    const runwayCrossChecked=runwayEvidence.status==='reference_verified'&&runwayEvidence.adequate===true&&
      airportDistance.status==='cross_checked'&&airportDistance.destinationAirportIdMatches===true&&
      quote.routeDirectionEvidence?.verified===true;
    const modelVariants=aircraftCatalog?.models.find(m=>m.modelId===quote.autopriceReference?.modelId)?.variants||[];
    const gameModeEvidence=inferGameModeEvidence(quote,modelVariants);
    const co2Calibration=aircraft
      ? calibrateCo2FromFlightHistory(aircraft,quotes.filter(q=>q.aircraftId===quote.aircraftId),routeCatalog,now,reservationsConfig.maxAgeSeconds)
      : null;
    const costScenarios=candidateCostScenarios(quote,capacity,reservations.forwardAfterReservations,
      {fuel:market.fuel,co2:market.co2,model,maintenance:maintenance.aircraft.find(a=>a.aircraftId===quote.aircraftId)||null,co2Calibration,gameModeEvidence},now,reservationsConfig.maxAgeSeconds);
    const effectiveCosts=effectiveCostBudget(quote,{},now,reservationsConfig.maxAgeSeconds);
    const reverseEquivalent=reverseLegEquivalentEvidence(quote,airportDistance,gameModeEvidence,quote.routeMutationControl||null);
    const roundTrip=buildCandidateRoundTripScreen(quote,routeCatalog,reservations,now,reservationsConfig.maxAgeSeconds,airportCatalog,reverseEquivalent);
    const fuel=market.fuel&&fresh(market.fuel.observedAt)&&fresh(quote.observedAt)?quote.fuelLbs*market.fuel.pricePer1000/1000:null;
    const priority=candidatePriorityReference(quote,screening,costScenarios);
    const currentSample=demandLabelCalibration.samples.find(s=>s.aircraftId===quote.aircraftId&&s.currentRouteQuote);
    const currentQuote=currentSample?.currentRouteQuote||null;
    const currentModel=currentQuote?models.find(m=>m.modelId===currentQuote.autopriceReference?.modelId)||null:null;
    const currentVariants=currentQuote?aircraftCatalog?.models.find(m=>m.modelId===currentQuote.autopriceReference?.modelId)?.variants||[]:[];
    const currentGameModeEvidence=currentQuote?inferGameModeEvidence(currentQuote,currentVariants):null;
    const currentAirportDistance=currentQuote?airportDistanceEvidence(currentQuote.from,currentQuote.to,airportCatalog,currentQuote.distanceKm,currentQuote.airportId):null;
    const loadFactorCalibration=currentQuote&&aircraft?
      calibrateCurrentFareLoadFactor(aircraft,currentQuote,currentGameModeEvidence,currentAirportDistance):null;
    const candidateLoadFactor=loadFactorCalibration?
      transferCurrentFareLoadFactor(loadFactorCalibration,quote,capacity,screening.adjustedFareReference,reverseEquivalent.status==='verified'):null;
    const currentReservations=currentQuote?candidateReservationScenario(currentQuote,collection,now,reservationsConfig,demandResetCalibration,liveStitches):null;
    const currentReverseEquivalent=currentQuote&&currentAirportDistance&&currentGameModeEvidence?
      reverseLegEquivalentEvidence(currentQuote,currentAirportDistance,currentGameModeEvidence,currentQuote.routeMutationControl||null):null;
    const currentCosts=currentQuote&&aircraft?candidateCostScenarios(currentQuote,aircraft.capacity,
      currentReservations?.forwardAfterReservations||aircraft.remaining,
      {fuel:market.fuel,co2:market.co2,model:currentModel,maintenance:maintenance.aircraft.find(a=>a.aircraftId===quote.aircraftId)||null,co2Calibration,gameModeEvidence:currentGameModeEvidence},
      now,reservationsConfig.maxAgeSeconds):null;
    const communityCostVerified=(m:ModelCostReference|null,variants:typeof modelVariants,mode:typeof gameModeEvidence)=>{
      if(!m?.acquisitionCost||!Number.isFinite(m.acquisitionCost)||m.acquisitionCost<=0)return false;
      if(m.source==='inspected-catalog')return m.communityCrossCheck?.verified===true;
      if(m.source!=='community-reference'||mode.status!=='verified'||mode.variantPriority===null)return false;
      const selected=variants.filter(v=>v.priority===mode.variantPriority&&v.modelId===m.modelId);
      return selected.length===1&&selected[0].acquisitionCost===m.acquisitionCost&&selected[0].aCheckPrice===m.aCheckPrice&&
        selected[0].checkIntervalHours===m.checkIntervalHours;
    };
    const candidateRepairReferenceVerified=communityCostVerified(model,modelVariants,gameModeEvidence);
    const currentRepairReferenceVerified=currentModel&&currentGameModeEvidence?
      communityCostVerified(currentModel,currentVariants,currentGameModeEvidence):false;
    const candidateSharedRemaining=conservativeSharedPairRemaining(reservations.forwardAfterReservations,reservations.reverseAfterReservations);
    const currentSharedRemaining=currentReservations?
      conservativeSharedPairRemaining(currentReservations.forwardAfterReservations,currentReservations.reverseAfterReservations):null;
    const candidateVariableCycle=routeVariableRoundTripInterval(
      quote,capacity,candidateSharedRemaining,screening.adjustedFareReference,candidateLoadEnvelope(candidateLoadFactor),
      costScenarios,co2Calibration,market.co2,candidateRepairReferenceVerified,quote.routeFee,reverseEquivalent,
      reservations.futureCompetitionComplete,now,reservationsConfig.maxAgeSeconds
    );
    const dailyPotential=routeDailyPotential(candidateVariableCycle,quote.observedAt,now,reservationsConfig.maxAgeSeconds);
    const currentVariableCycle=currentQuote&&aircraft&&currentCosts&&loadFactorCalibration?
      routeVariableRoundTripInterval(
        currentQuote,aircraft.capacity,currentSharedRemaining,aircraft.fares?.current||null,currentRouteLoadEnvelope(loadFactorCalibration),
        currentCosts,co2Calibration,market.co2,currentRepairReferenceVerified,0,currentReverseEquivalent,
        currentReservations?.futureCompetitionComplete===true,now,reservationsConfig.maxAgeSeconds
      ):null;
    const currentGrossRevenueCeiling=currentQuote&&aircraft?
      currentRouteGrossRevenueCeiling(currentQuote,aircraft.capacity,aircraft.fares?.current||null,currentReverseEquivalent,now,reservationsConfig.maxAgeSeconds):null;
    const demandHold=demandHoldByAircraft.get(quote.aircraftId);
    const currentDemandHoldVerified=!!aircraft&&!!demandHold&&demandHold.routeId===aircraft.routeId&&
      demandHold.from===aircraft.from&&demandHold.to===aircraft.to&&freshAt(demandHold.observedAt,now)&&
      typeof demandHold.occupancyPercentage==='number'&&Number.isFinite(demandHold.occupancyPercentage)&&
      typeof demandHold.thresholdPercentage==='number'&&Number.isFinite(demandHold.thresholdPercentage)&&
      demandHold.occupancyPercentage<demandHold.thresholdPercentage;
    const variableCycleComparison=compareRouteVariableCycles(
      currentVariableCycle,candidateVariableCycle,0,currentGrossRevenueCeiling,currentDemandHoldVerified
    );
    const currentKnown=currentQuote&&aircraft&&currentCosts?
      knownContributionLeg(currentQuote,aircraft.capacity,aircraft.remaining,aircraft.fares?.current||null,currentCosts):null;
    const candidateKnown=knownContributionLeg(quote,capacity,reservations.forwardAfterReservations,screening.adjustedFareReference,costScenarios);
    const knownContributionComparison=currentKnown?
      compareKnownContribution(currentKnown,candidateKnown,quote.routeFee):
      {status:'unavailable' as const,current:null,candidate:candidateKnown,componentSetMatches:false,deltaKnownContributionPerHour:null,
       candidateFirstCycleAfterSetupKnownContribution:null,reason:'CURRENT_ROUTE_REFERENCE_UNAVAILABLE',comparisonReady:false as const,mutationAuthorized:false as const};
    const routeExecutionEvidence={
      observedAt:quote.observedAt,costIndex:quote.costIndex,distanceKm:quote.distanceKm,durationSeconds:quote.durationSeconds,
      fuelLbs:quote.fuelLbs,co2KgPerPaxKm:quote.co2KgPerPaxKm,routeFee:quote.routeFee,
      autoFares:quote.autopriceReference?.effectiveFares?{...quote.autopriceReference.effectiveFares}:null
    };
    return {aircraftId:quote.aircraftId,airportId:quote.airportId,from:quote.from,to:quote.to,quoteObservedAt:quote.observedAt,
      routeExecutionEvidence,dailyPotential,
      createControl:quote.createControl||null,routeActionDiagnostics:quote.routeActionDiagnostics||[],routeListenerDiagnostics:quote.routeListenerDiagnostics||[],routeMutationControl:quote.routeMutationControl||null,autopriceFunctionEvidence:quote.autopriceFunctionEvidence||null,quoteFieldDiagnostics:quote.quoteFieldDiagnostics||[],routeDirectionEvidence:quote.routeDirectionEvidence||null,routeResponseDiagnostics:quote.routeResponseDiagnostics||null,airportDistance,runwayEvidence,runwayCrossChecked,gameModeEvidence,currentGameModeEvidence,currentAirportDistance,reverseEquivalent,currentReverseEquivalent,loadFactorCalibration,candidateLoadFactor,candidateRepairReferenceVerified,currentRepairReferenceVerified,routeProfitModel,candidateVariableCycle,currentVariableCycle,currentGrossRevenueCeiling,variableCycleComparison,co2Calibration,demand,screening,priority,knownContributionComparison,roundTrip,reservations,currentReservations,costScenarios,effectiveCosts,modelCostReference:model,costs:{fuelAtObservedMarketPrice:fuel,co2:null,maintenance:null,airportAndOther:null},
      routeTrigger:currentDemandHoldVerified?'demand_insufficient':'scheduled_review',
      setupFee:quote.routeFee,costsComplete:false,netProfit:null,comparisonReady:false,mutationAuthorized:false,
      missing:['FUTURE_OTHER_AIRCRAFT_RESERVATIONS','REVERSE_LEG_ECONOMICS',
        ...(!(screening.adjustedFareReference&&candidateLoadFactor?.verified)?['EFFECTIVE_FARES_AND_LOAD_FACTOR']:[]),
        ...(!co2Calibration?.formulaVerified?['CO2_QUOTA_CONVERSION']:[]),
        'AIRCRAFT_EFFECTIVE_MAINTENANCE','AIRPORT_AND_OTHER_COSTS','FUTURE_SCHEDULE_AND_RESET',
        ...(!demand.remaining?['DIRECTIONAL_REMAINING_DEMAND']:[]),...(fuel===null?['FUEL_MARKET_PRICE']:[])]};
  });
  const priorityRanking=rankCandidatePriorities(candidates);
  const dailyPotentialRanking=rankDailyRouteScenarios(candidates);
  const routeReadiness=summarizeComparisonReadiness(candidates);
  for(const candidate of candidates){
    const readiness=routeReadiness.candidates.find(r=>r.aircraftId===candidate.aircraftId&&r.from===candidate.from&&r.to===candidate.to);
    candidate.comparisonReady=readiness?.comparisonReady===true;
  }
  const routeDecisions=[...new Set(candidates.map(c=>c.aircraftId))].map(aircraftId=>planVariableRouteDecision(
    aircraftId,
    candidates.filter(c=>c.aircraftId===aircraftId).map(c=>({
      aircraftId:c.aircraftId,from:c.from,to:c.to,airportId:c.airportId,
      comparisonReady:routeReadiness.candidates.find(r=>r.aircraftId===c.aircraftId&&r.from===c.from&&r.to===c.to)?.comparisonReady===true,
      variableCycleComparison:c.variableCycleComparison,
      candidateVariableCycle:c.candidateVariableCycle,
      routeMutationControl:c.routeMutationControl
    }))
  ));
  return {schemaVersion:16,generatedAt:now.toISOString(),dryRun:true,mutationAuthorized:false,
    comparisonReady:routeDecisionSetComparisonReady(routeDecisions),
    uiRestored,screenedOutBeforeModelReference,routeProfitModel,reputation,demandLabelCalibration,demandResetCalibration,flightHistoryCoverage,market,models,modelReads,maintenance,financeHistory,priorityRanking,dailyPotentialRanking,routeReadiness,routeDecisions,
    warnings:[...warnings,...maintenance.warnings,...financeHistory.warnings],candidates};
}
export async function writeCandidateDataReport(report:Awaited<ReturnType<typeof collectCandidateData>>,directory='test-results/demand'){
  await mkdir(directory,{recursive:true});
  await writeFile(join(directory,'candidate-data.json'),JSON.stringify(report,null,2)+'\n');
  await writeFile(join(directory,'finance-history.json'),JSON.stringify(report.financeHistory,null,2)+'\n');
  await writeFile(join(directory,'candidate-data.md'),['# Evidencias das candidatas — simulacao','',
    '## Modelo de lucro por rota','',
    `- Status: ${report.routeProfitModel.status}; componentes ${report.routeProfitModel.componentSet.join(', ')}; fonte ${report.routeProfitModel.sourceRepository}@${report.routeProfitModel.sourceCommit} ${report.routeProfitModel.sourcePath}.`,
    `- Fluxos de companhia excluidos do lucro por rota: ${report.routeProfitModel.excludedCompanyLevel.join(', ')}.`,
    'Cada entrada variavel ainda precisa ser validada pela conta live; este modelo nao autoriza mutacao.','',
    '## Diagnostico de reputacao — somente leitura','',
    `- Status: ${report.reputation.status}; percentuais observados sem classificacao: ${report.reputation.parsedPercentages.join(', ')||'nenhum'}.`,
    ...report.reputation.entries.map(e=>`- ${e.tag}${e.id?'#'+e.id:''}: ${e.text||e.title||e.ariaLabel||'sem texto'}.`),
    'Nenhum percentual e tratado como reputacao PAX ou fator de carga ate a estrutura real ser confirmada por parser estrito.','',
    '## Calibracao do rotulo Daily pax demand','',
    `- Status: ${report.demandLabelCalibration.status}; classificacao: ${report.demandLabelCalibration.classification}; amostras: ${report.demandLabelCalibration.samples.length}.`,
    ...report.demandLabelCalibration.samples.map(s=>`- ${s.aircraftId} ${s.from}–${s.to}: quote ${JSON.stringify(s.quoteDemand)}; remaining ${JSON.stringify(s.remaining)}; dailyTotal ${JSON.stringify(s.dailyTotal)}; match remaining ${s.matchesRemaining}; match daily ${s.matchesDailyTotal}.`),
    'O rotulo somente pode ser promovido a demanda restante se varias observacoes atuais e independentes o confirmarem; igualdade remaining=dailyTotal fica inconclusiva.','',
    '## Ledger historico do reset de demanda','',
    `- Status: ${report.demandResetCalibration.status}; janelas verificadas: ${report.demandResetCalibration.windows.length}; limite superior da idade do reset: ${report.demandResetCalibration.resetAgeUpperBoundMinutes??'indisponivel'} min.`,
    ...report.demandResetCalibration.windows.map(w=>`- ${w.pairKey}: consumo confirmado ${JSON.stringify(w.consumed)}; bucket incluido ate ${w.includedMaxAgeMinutes} min; proximo bucket excluido em ${w.excludedMinAgeMinutes} min.`),
    ...report.demandResetCalibration.upperBoundSources.map(s=>`- Limite superior por ${s.aircraftId} ${s.from}–${s.to}: ultima decolagem no mesmo sentido ha ${s.newestSameDirectionFlightAgeMinutes} min, enquanto remaining=dailyTotal.`),
    'A reconstrucao candidata so e usada quando todo o historico da frota cobre a janela calibrada e nenhum voo do par cai na faixa ambigua do reset.','',
    '### Cobertura visivel do Flight History','',
    ...report.flightHistoryCoverage.map(x=>`- ${x.aircraftId} ${x.registration}: ${x.visibleEntries} entradas; mais antiga ${x.oldestAgeMinutes??'indisponivel'} min; ciclos ${x.cycles??'indisponivel'}; limite necessario ${x.requiredExcludedMin??'indisponivel'} min; cobre reset ${x.coversReset?'sim':'nao'}${x.lifetimeCovered?' (historico de vida completo)':''}.`),
    'Este diagnostico nao estende o historico nem autoriza comparacao; apenas identifica a lacuna observada.','',
    ...(report.priorityRanking.length?[
      '## Ranking de referencia entre candidatas observadas','',
      ...report.priorityRanking.map(r=>`- #${r.rank} ${r.from}–${r.to}: teto de contribuicao conhecida/h ${r.recurringKnownContributionCeilingPerHour.toFixed(2)}; teto do primeiro ciclo apos taxa ${r.firstCycleKnownContributionCeiling.toFixed(2)}.`),
      '',
      'Ranking apenas para priorizar pesquisa: usa teto de receita, combustivel a preco de reposicao e prorata de A-check do catalogo. Nao e lucro liquido nem autoriza reroute.',''
    ]:[]),
    ...(report.dailyPotentialRanking.length?[
      '## Teto teorico de ciclos completos em 24h — somente leitura','',
      ...report.dailyPotentialRanking.map(r=>`- Aeronave ${r.aircraftId} #${r.rank}: ${r.from}–${r.to}; no maximo ${r.theoreticalCycleCeiling} ciclos por tempo e demanda atual; sensibilidade de lucro variavel 24h low ${r.illustrative24hProfitLow.toFixed(2)}, expected ${r.illustrative24hProfitExpected.toFixed(2)} apos uma taxa de criacao.`),
      '',
      'Nao e agenda nem lucro diario garantido: sem renovacao da demanda, esperas em solo, futuras partidas concorrentes, variacao de precos ou reposicionamento. O numero e apenas um teto fisico/estatico, e nao altera KEEP/HOLD/REROUTE.',''
    ]:[]),
    ...(report.routeReadiness.candidates.length?[
      '## Prontidao para comparacao e reroute','',
      ...report.routeReadiness.candidates.map(r=>`- ${r.aircraftId} ${r.from}–${r.to}: comparacao ${r.comparisonReady?'pronta':'bloqueada'}; bloqueios ${r.comparisonBlockers.join(', ')||'nenhum'}; mutacao ${r.mutationReady?'pronta':'bloqueada'}; bloqueios ${r.mutationBlockers.join(', ')||'nenhum'}.`),
      '',
      'Este gate apenas consolida evidencias. mutationAuthorized permanece false ate existir comparacao completa e executor nativo verificado.',''
    ]:[]),
    ...(report.routeDecisions.length?[
      '## Decisao conservadora por aeronave — somente leitura','',
      ...report.routeDecisions.map(d=>`- ${d.aircraftId}: ${d.decision}; comparadas ${d.compared}; dominantes ${d.dominating}; selecionada ${d.selected?`${d.selected.from}–${d.selected.to} (${d.selected.conservativeProfitPerHour.toFixed(2)}/h low, primeiro ciclo low ${d.selected.firstCycleLow.toFixed(2)})`:'nenhuma'}; motivo ${d.reason}.`),
      '',
      'would_reroute e somente um plano; nenhuma rota e alterada por este relatorio.',''
    ]:[]),
    ...report.candidates.map(c=>`- ${c.aircraftId} ${c.from}–${c.to}: triagem ${c.screening.demandStatus}, teto de cobertura ${c.screening.coverageCeilingPercent===null?'indisponivel':c.screening.coverageCeilingPercent.toFixed(2)+'%'}, teto de receita/decolagem ${c.screening.grossRevenueCeilingPerDeparture??'indisponivel'}, prioridade ${c.priority.status==='rankable'?c.priority.recurringKnownContributionCeilingPerHour?.toFixed(2)+'/h':'indisponivel'}; delta contribuicao conhecida vs atual ${c.knownContributionComparison.status==='comparable_reference'?(c.knownContributionComparison.deltaKnownContributionPerHour??0).toFixed(2)+'/h':'indisponivel'}; ciclo variavel ${c.candidateVariableCycle.status}, atual ${c.currentVariableCycle?.status||'indisponivel'}, comparacao ${c.variableCycleComparison.status} (${c.variableCycleComparison.comparisonBasis}), delta conservador/h ${c.variableCycleComparison.deltaPerHour.conservativeLower===null?'indisponivel':c.variableCycleComparison.deltaPerHour.conservativeLower.toFixed(2)}, primeiro ciclo low ${c.candidateVariableCycle.firstCycleAfterSetup.low===null?'indisponivel':c.candidateVariableCycle.firstCycleAfterSetup.low.toFixed(2)}; teto 24h ${c.dailyPotential.theoreticalCycleCeiling??'indisponivel'} ciclos (${c.dailyPotential.reason}); Create route ${c.createControl?.observed?'observado':'nao observado'}, endpoints ${c.createControl?.phpEndpoints?.join(', ')||'nenhum'}, shape ${c.createControl?.onclickShape||'indisponivel'}; controles inspecionados ${c.routeActionDiagnostics.length}: ${c.routeActionDiagnostics.map(a=>[a.tag,a.id||'',a.label||'',a.phpEndpoints.join('+')||'',a.callbackShape||a.hrefShape||''].filter(Boolean).join(' ')).join(' || ')||'nenhum'}; listeners ${c.routeListenerDiagnostics.length}: ${c.routeListenerDiagnostics.map(a=>[a.scope,a.event,a.elementTag||'',a.elementId||'',a.elementLabel||'',a.phpEndpoints.join('+')||'',a.handlerShape||''].filter(Boolean).join(' ')).join(' || ')||'nenhum'}; Create route validado ${c.routeMutationControl?.nativeClickReady?'sim':'nao'}; endpoint ${c.routeMutationControl?.endpointVerified?'ok':'nao'}; aeronave ${c.routeMutationControl?.aircraftIdMatchesContext?'ok':'nao'}; aeroporto ${c.routeMutationControl?.airportIdMatchesContext?'ok':'nao'}; Autoprice funcao ${c.autopriceFunctionEvidence?.observed?'observada':'indisponivel'}, rede ${c.autopriceFunctionEvidence?.networkMutationObserved?'detectada':'nao detectada'}, modelos ${c.autopriceFunctionEvidence?.modelIds?.join('+')||'nenhum'}; resposta rota ${c.routeResponseDiagnostics?.observed?'observada':'indisponivel'}, sinais demanda ${c.routeResponseDiagnostics?.demandSignals?.join(' || ')||'nenhum'}, inputs ocultos ${c.routeResponseDiagnostics?.hiddenInputs?.map(x=>x.name).join('+')||'nenhum'}; campos operacionais ${c.quoteFieldDiagnostics.map(f=>[f.id||'',f.label||'',f.title||''].filter(Boolean).join(' ')).join(' || ')||'nenhum'}; pistas ref ${c.runwayEvidence.originRunwayFt??'?'}/${c.runwayEvidence.destinationRunwayFt??'?'} ft, requerido ${c.runwayEvidence.requiredRunwayFt}, status ${c.runwayEvidence.status}, cross-check ${c.runwayCrossChecked?'ok':'nao'}; distancia airport ref ${c.airportDistance.distanceKm??'?'}, delta ${c.airportDistance.deltaKm??'?'}, airportId ${c.airportDistance.destinationAirportIdMatches===true?'ok':c.airportDistance.destinationAirportIdMatches===false?'mismatch':'n/a'}; modo ${c.gameModeEvidence.status==='verified'?c.gameModeEvidence.mode:'indisponivel'}, velocidade ${c.gameModeEvidence.speedMatches?'ok':'nao'}, treino combustivel ${c.gameModeEvidence.fuelTraining??'indisponivel'}; volta equivalente ${c.reverseEquivalent.status==='verified'?'verificada':'indisponivel'}; carga ${c.candidateLoadFactor?.verified?(c.candidateLoadFactor.expectedAggregate!*100).toFixed(2)+'%':'indisponivel'} (${c.loadFactorCalibration?.sampleCount??0} amostras tarifa atual); CO2 calibracao ${c.co2Calibration?.status||'indisponivel'}, formula ${c.co2Calibration?.formulaVerified?'verificada':'nao verificada'}, fator ${c.co2Calibration?.quoteFactor??'indisponivel'}, intercepto/km ${c.co2Calibration?.fixedQuotasPerKm??'indisponivel'}, amostras ${c.co2Calibration?.samples.length??0}; ciclo ${c.roundTrip.status}, volta ${c.roundTrip.returnLeg.from}–${c.roundTrip.returnLeg.to}, demanda restante volta ${JSON.stringify(c.roundTrip.returnLeg.remainingAfterReservations)}, bloqueios ciclo ${c.roundTrip.blockers.join(', ')}; demanda restante ida ${c.demand.status}; reservas ${c.reservations.status} (${c.reservations.reservations.length} trechos); saldo simulado ida ${JSON.stringify(c.reservations.forwardAfterReservations)}; combustivel ao preco observado ${c.costs.fuelAtObservedMarketPrice??'indisponivel'}; CO2 de referencia ${c.costScenarios.co2.atDemandCeiling??'indisponivel'}; A-check de referencia ${c.costScenarios.aCheck.catalogProration??'indisponivel'}; custos efetivos faltantes ${c.effectiveCosts.missing.join(', ')}; pendencias ${c.missing.join(', ')}.`),'',
    `Candidatas descartadas antes da consulta de referencia por nao atingirem o limite nem no teto diario: ${report.screenedOutBeforeModelReference}.`,'',
    `Manutencao: ${report.maintenance.status}; referencias individuais ${report.maintenance.aircraft.length}. Reservas sao cenarios limitados de capacidade antes da candidata; nao sao previsao de horarios nem reservas feitas no jogo.`,
    `Historico financeiro: ${report.financeHistory.status}; lancamentos visiveis ${report.financeHistory.transactions.length}. Compras observadas sao referencias de pagamentos; nao comprovam custo medio do estoque, despesa por trecho ou historico completo.`,
    'Referencia de A-check do catalogo nao confirma o custo efetivo da aeronave. Preco de mercado nao confirma o custo de aquisicao do estoque. Taxa de criacao nao e custo recorrente. Nenhum lucro liquido ou troca de rota autorizado.',
    ...report.warnings.map(w=>'- '+w),''].join('\n'));
}
