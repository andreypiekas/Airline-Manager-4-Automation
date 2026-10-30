const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');

const read=(dir,name)=>{try{return JSON.parse(fs.readFileSync(path.join(dir,name),'utf8'));}catch{return null;}};
const readPath=file=>{try{return JSON.parse(fs.readFileSync(file,'utf8'));}catch{return null;}};
const safe=s=>String(s??'').replace(/[|\r\n<>]/g,' ');

function build(dir='test-results/demand',logPath='test-results/bot.log',journalPath='.am4-state/github/return-journal.json'){
  const demand=read(dir,'demand-report.json'),fleet=read(dir,'fleet-observations.json'),execution=read(dir,'execution-report.json'),
    routeExecution=read(dir,'route-execution.json'),routeResearch=read(dir,'route-research.json'),candidateData=read(dir,'candidate-data.json'),supplies=read(dir,'supply-report.json'),postSupplies=read(dir,'supply-post-report.json'),pricing=read(dir,'pricing-execution.json'),modules=read(dir,'operational-modules.json'),
    uiHealth=read(dir,'ui-health.json'),challenge=read(dir,'challenge-detected.json'),semi=read(dir,'semi-automatic-summary.json'),runBudget=read(dir,'run-time-budget.json'),ownedBases=read(dir,'owned-airline-bases.json'),globalFallback=read(dir,'global-fleet-fallback.json'),pageOnly=read(dir,'first-page-only-report.json');
  const log=(()=>{try{return fs.readFileSync(logPath,'utf8')}catch{return ''}})();
  const journal=readPath(journalPath),events=Array.isArray(journal?.events)?journal.events:[];
  const resolvedUncertainDepartureIds=new Set(events.filter(x=>x?.type==='departure-uncertain-resolved').map(x=>x.uncertainEventId));
  const uncertainDepartureKeys=new Set(events.filter(x=>x?.type==='departure-uncertain'&&!resolvedUncertainDepartureIds.has(x.eventId)).map(x=>x.aircraftId+':'+x.routeId));
  const uncertainRouteAircraftIds=new Set(events.filter(x=>x?.type==='route-uncertain').map(x=>x.aircraftId));
  const uncertainPricingRouteIds=new Set(events.filter(x=>x?.type==='pricing-uncertain').map(x=>x.routeId));
  const supplyObservations=Array.isArray(journal?.supplyObservations)?journal.supplyObservations:[];
  const uncertainSupplyKinds=new Set();
  for(const kind of ['fuel','co2']){
    const latestUncertain=Math.max(0,...events.filter(x=>x?.type==='supply-uncertain'&&x.kind===kind).map(x=>Date.parse(x.observedAt)||0));
    const latestVerified=Math.max(0,...supplyObservations.filter(x=>x?.kind===kind).map(x=>Date.parse(x.observedAt)||0));
    if(latestUncertain&&latestVerified<=latestUncertain)uncertainSupplyKinds.add(kind);
  }
  const aircraft=Array.isArray(fleet?.aircraft)?fleet.aircraft:[];
  const scopedPage=pageOnly?.mode==='current-first-page-only'&&pageOnly?.globalComplete===false&&
    Number.isSafeInteger(pageOnly.evaluated)&&pageOnly.evaluated>=0;
  const partialGlobal=globalFallback?.globalComplete===false&&Number.isSafeInteger(globalFallback.observed)&&
    Number.isSafeInteger(globalFallback.expected)&&globalFallback.observed>=0&&
    globalFallback.expected>0&&globalFallback.observed<=globalFallback.expected;
  // Verified individual entries are a bounded first-page sample, never a complete fleet.
  const individualVerified=(partialGlobal||scopedPage)?(execution?.entries||[]).filter(e=>
    e?.demand?.state==='ready'&&e?.demand?.aircraftId===e?.aircraftId&&
    e?.demand?.routeId===e?.routeId&&typeof e?.registration==='string'&&!!e.registration).length:0;
  const currentAircraftRouteKeys=new Set(aircraft.map(a=>a.aircraftId+':'+a.routeId));
  const activeUncertainDepartureKeys=new Set([...uncertainDepartureKeys].filter(k=>currentAircraftRouteKeys.has(k)));
  const execBy=new Map((execution?.entries||[]).map(x=>[x.aircraftId,x]));
  const routeBy=new Map((routeExecution?.entries||[]).map(x=>[x.aircraftId,x]));
  const routeDecisionBy=new Map((candidateData?.routeDecisions||[]).map(x=>[x.aircraftId,x]));
  const states=aircraft.map(a=>{
    const e=execBy.get(a.aircraftId),r=routeBy.get(a.aircraftId),rd=routeDecisionBy.get(a.aircraftId);
    let state='NORMAL',reason=a.state==='inflight'?'INFLIGHT_OBSERVED':'OBSERVED_WITHOUT_ACTION';
    if(a.issue&&/maintenance|repair|a-check|check/i.test(String(a.issue))){state='MANUTENCAO';reason='MAINTENANCE_ISSUE_OBSERVED';}
    else if(uncertainRouteAircraftIds.has(a.aircraftId)){state='PRECISA_REVISAR_ROTA';reason='PERSISTED_UNCERTAIN_ROUTE_BLOCK';}
    else if(activeUncertainDepartureKeys.has(a.aircraftId+':'+a.routeId)){state='QUARENTENA_DECOLAGEM';reason='PERSISTED_UNCERTAIN_DEPARTURE_BLOCK';}
    else if(r?.status==='held'){state='PRECISA_REVISAR_ROTA';reason='REROUTE_HELD:'+r.reason;}
    else if(r?.status==='outcome_unknown'){state='PRECISA_REVISAR_ROTA';reason='REROUTE_OUTCOME_UNKNOWN_NO_RETRY';}
    else if(e?.status==='outcome_unknown'){state='QUARENTENA_DECOLAGEM';reason='DEPARTURE_OUTCOME_UNKNOWN_NO_RETRY';}
    else if(e?.status==='held'&&e.reason==='PERSISTED_UNCERTAIN_DEPARTURE_BLOCK'){state='QUARENTENA_DECOLAGEM';reason='PERSISTED_UNCERTAIN_DEPARTURE_BLOCK';}
    else if(e?.status==='held'&&['FUEL_STOCK_INSUFFICIENT_BY_VERIFIED_HISTORY','FUEL_REQUIREMENT_UNVERIFIED','FUEL_BUDGET_UNVERIFIED_AFTER_PRIOR_DEPARTURE'].includes(e.reason)){state='AGUARDANDO_RECURSO';reason=e.reason;}
    else if(uncertainPricingRouteIds.has(a.routeId)){state='PRECISA_REVISAR_PRECO';reason='PERSISTED_UNCERTAIN_PRICING_BLOCK';}
    else if(e?.status==='held'&&e.reason==='REROUTE_PRICING_NOT_VERIFIED'){state='PRECISA_REVISAR_PRECO';reason='REROUTE_PRICING_NOT_VERIFIED';}
    else if(e?.status==='departed'){state='NORMAL';reason='DEPARTED_THIS_RUN';}
    else if(a.state==='unavailable'){state='DADOS_INDISPONIVEIS';reason='DETAILS_UNVERIFIED';}
    else if(a.detailsVerified===true&&!a.operationalOrigin&&a.originResolution?.source==='unavailable'){state='ORIGEM_OPERACIONAL_INDEFINIDA';reason='ORIGIN_NOT_REGISTERED';}
    else if(e?.status==='held'&&e.demand?.decision==='hold_insufficient'){state='AGUARDANDO_DEMANDA';reason='DEMAND_INSUFFICIENT_VERIFIED';}
    else if(rd?.decision==='hold'){state='PRECISA_REVISAR_ROTA';reason='ROUTE_REVIEW_HOLD:'+rd.reason;}
    else if(a.state==='ready'&&e?.status==='held'){state='PRONTA_PARA_DECOLAR';reason='DEPARTURE_HELD:'+e.reason;}
    else if(a.state==='ready'){state='PRONTA_PARA_DECOLAR';reason='READY_OBSERVED_NO_DEPARTURE_RESULT';}
    return {aircraftId:a.aircraftId,registration:a.registration||'unknown',state,reason,observedFleetState:a.state||'unknown'};
  });
  const count=s=>states.filter(x=>x.state===s).length;
  const supply={};
  for(const x of supplies?.entries||[])supply[x.kind]={status:x.status,reason:x.reason,pricePer1000:x.before?.pricePer1000??null,quantity:x.plan?.quantity??null,estimatedCost:x.plan?.estimatedCost??null};
  const postSupply={};
  for(const x of postSupplies?.entries||[])postSupply[x.kind]={
    status:x.status,reason:x.reason,pricePer1000:x.before?.pricePer1000??null,
    quantity:x.plan?.quantity??null,estimatedCost:x.plan?.estimatedCost??null,
    confirmedCost:x.status==='purchased'?x.quotedCost??null:null
  };
  for(const [kind,policy] of Object.entries(supplies?.adaptive||{}))if(supply[kind])Object.assign(supply[kind],{effectiveMax:policy?.effectiveMax??null,policySource:policy?.source??null,samples:policy?.samples??null});
  const dashboard={
    schemaVersion:1,generatedAt:new Date().toISOString(),source:'observed-run-artifacts-only',
    run:{number:process.env.GITHUB_RUN_NUMBER||null,id:process.env.GITHUB_RUN_ID||null,attempt:process.env.GITHUB_RUN_ATTEMPT||null,
      sha:process.env.GITHUB_SHA||null,event:process.env.GITHUB_EVENT_NAME||null,result:process.env.BOT_RESULT||null,
      stale:process.env.STALE_RUN==='true',mode:process.env.AUTOMATION_MODE||(execution?(execution.dryRun?'simulation':'production'):null),url:process.env.RUN_URL||null},
    bases:{status:ownedBases?.status??'not_observed',effective:Array.isArray(ownedBases?.effectiveBases)?ownedBases.effectiveBases:[],source:ownedBases?.source??null,reason:ownedBases?.reason??null},
    demand:{collectionComplete:demand?.collectionComplete??null,evaluated:demand?.summary?.evaluated??null,sufficient:demand?.summary?.sufficient??null,
      insufficient:demand?.summary?.insufficient??null,unavailable:demand?.summary?.unavailable??null,notReady:demand?.summary?.notReady??null},
    fleet:{seen:scopedPage?pageOnly.evaluated:(partialGlobal?globalFallback.observed:(demand?.summary?.fleetSeen??aircraft.length)),
      expected:partialGlobal?globalFallback.expected:null,collectionComplete:scopedPage?false:(demand?.collectionComplete??(partialGlobal?false:null)),
      scope:scopedPage?'FIRST_PAGE_ONLY':partialGlobal?'GLOBAL_PARTIAL':'GLOBAL_OBSERVED',
      individualVerified,ready:aircraft.filter(a=>a.state==='ready').length,
      inflight:aircraft.filter(a=>a.state==='inflight').length,unavailable:aircraft.filter(a=>a.state==='unavailable').length},
    departures:{evaluated:execution?.summary?.evaluated??null,departed:execution?.summary?.departed??null,held:execution?.summary?.held??null,unknown:execution?.summary?.unknown??null,
      fuelHeld:(execution?.entries||[]).filter(x=>x?.status==='held'&&x?.reason==='FUEL_STOCK_INSUFFICIENT_BY_VERIFIED_HISTORY').length,
      timeBudgetHeld:(execution?.entries||[]).filter(x=>x?.status==='held'&&/^RUN_TIME_BUDGET_EXHAUSTED_BEFORE_/.test(x?.reason||'')).length},
    routes:{evaluated:routeExecution?.summary?.evaluated??null,rerouted:routeExecution?.summary?.rerouted??null,
      held:routeExecution?.summary?.held??null,unknown:routeExecution?.summary?.unknown??null,
      reviewDecisions:{
        keep:(candidateData?.routeDecisions||[]).filter(x=>x?.decision==='keep_route').length,
        hold:(candidateData?.routeDecisions||[]).filter(x=>x?.decision==='hold').length,
        wouldReroute:(candidateData?.routeDecisions||[]).filter(x=>x?.decision==='would_reroute').length,
        unavailable:(candidateData?.routeDecisions||[]).filter(x=>x?.decision==='unavailable').length
      },
      demandTriggered:{
        eligible:routeResearch?.queueRotation?.demandTriggeredEligible??0,
        observed:(routeResearch?.aircraft||[]).filter(a=>a?.trigger==='demand_insufficient'&&a?.status==='observed').length,
        deferred:(routeResearch?.aircraft||[]).filter(a=>a?.trigger==='demand_insufficient'&&a?.status==='deferred_limit').length,
        unavailable:(routeResearch?.aircraft||[]).filter(a=>a?.trigger==='demand_insufficient'&&['unavailable','journal_unavailable','data_unavailable','origin_unavailable'].includes(a?.status)).length
      },
      originUnavailable:aircraft.filter(a=>a.detailsVerified===true&&!a.operationalOrigin&&a.originResolution?.source==='unavailable').length},
    pricing:{evaluated:pricing?.summary?.evaluated??semi?.fleet?.seen??null,adjusted:pricing?.summary?.adjusted??null,
      suggested:semi?.pricing?.wouldAdjust??null,recommendationOnly:semi?.pricing?.recommendationOnly??null,
      unchanged:pricing?.summary?.unchanged??semi?.pricing?.unchanged??null,unknown:pricing?.summary?.unknown??null,
      phaseHoldReason:pricing?.phaseHoldReason??null},
    operationalStates:{NORMAL:count('NORMAL'),AGUARDANDO_DEMANDA:count('AGUARDANDO_DEMANDA'),AGUARDANDO_RECURSO:count('AGUARDANDO_RECURSO'),
      DADOS_INDISPONIVEIS:count('DADOS_INDISPONIVEIS'),QUARENTENA_DECOLAGEM:count('QUARENTENA_DECOLAGEM'),ORIGEM_OPERACIONAL_INDEFINIDA:count('ORIGEM_OPERACIONAL_INDEFINIDA'),
      PRECISA_REVISAR_ROTA:count('PRECISA_REVISAR_ROTA'),PRECISA_REVISAR_PRECO:count('PRECISA_REVISAR_PRECO'),MANUTENCAO:count('MANUTENCAO'),PRONTA_PARA_DECOLAR:count('PRONTA_PARA_DECOLAR')},
    quarantines:{departure:activeUncertainDepartureKeys.size,route:uncertainRouteAircraftIds.size,pricingRoute:uncertainPricingRouteIds.size,supplyKinds:uncertainSupplyKinds.size},
    maintenance:{preventiveACheckRepairs:modules?.maintenance?.status??(log.includes('[Operacao] Manutencao automatica finalizada.')?'completed_observed':
      log.includes('[Operacao] Iniciando manutencao preventiva, A-checks e reparos...')?'started_observed':'not_observed'),
      evidence:modules?.maintenance?.evidence??null,
      holdReason:modules?.maintenance?.status==='held_safe'?(modules?.maintenance?.evidence?.reason??'SAFE_HOLD'):null},
    campaign:{status:modules?.campaign?.status??(log.includes('[Campaign] Todas as campanhas exigidas foram confirmadas como ativas.')?'verified_active':
      log.includes('[Operacao] Verificando e contratando campanhas...')?'started_observed':'not_observed'),
      evidence:modules?.campaign?.evidence??null,
      allRequiredVerified:modules?.campaign?.evidence?.allRequiredVerified??null,
      departureAuthorized:modules?.campaign?.evidence?.departureAuthorized??null},
    supplies:supply,
    postDispatchSupplies:{observed:postSupplies?.phase==='post',halted:postSupplies?.halted??null,fuel:postSupply.fuel??null,co2:postSupply.co2??null},
    fuelPriceWindow:supplies?.fuelPriceWindow??null,
    uiHealth:{status:uiHealth?.status??'not_observed',mutationAuthorized:uiHealth?.mutationAuthorized??null,
      unhealthyChecks:(uiHealth?.checks||[]).filter(x=>x?.status!=='healthy').length},
    challenge:{detected:challenge?.detected===true,reason:challenge?.reason??null,stage:challenge?.stage??null},
    timeBudget:{blocked:(runBudget?.decisions||[]).filter(x=>x?.allowed===false).length,
      decisions:(runBudget?.decisions||[]).length}
  };
  return {dashboard,states};
}
function markdown(d,states){
 const s=d.fleet.collectionComplete===false?Object.fromEntries(Object.keys(d.operationalStates).map(k=>[k,'n/d'])):d.operationalStates,attention=states.filter(x=>x.state!=='NORMAL');
 const statusMap={success:'SUCESSO',failure:'FALHA',skipped:'IGNORADA'},runStatus=d.run?.stale?'IGNORADA — SHA OBSOLETO':(statusMap[d.run?.result]||String(d.run?.result||'DESCONHECIDO').toUpperCase());
 const mode=d.run?.mode==='production'?'PRODUÇÃO':d.run?.mode==='simulation'?'SIMULAÇÃO':d.run?.mode==='semi-automatic'?'SEMIAUTOMÁTICO':'N/D';
 const sha=d.run?.sha?String(d.run.sha).slice(0,8):'n/d';
 const q=d.quarantines,review=d.routes.reviewDecisions||{},fuel=d.supplies.fuel,co2=d.supplies.co2;
 const fmt=n=>Number.isSafeInteger(n)?n.toLocaleString('en-US'):(n??'n/d');
 const supplyText=(name,x)=>!x?`${name}: n/d`:`${name}: ${x.status} (${x.reason||'sem motivo'}${Number.isSafeInteger(x.pricePer1000)?`; preço ${fmt(x.pricePer1000)}/1k`:''}${Number.isSafeInteger(x.quantity)?`; qtd ${fmt(x.quantity)}`:''})`;
 const alerts=[];
 if(q.departure)alerts.push(`${q.departure} quarentena(s) persistente(s) de decolagem`);
 if(q.route)alerts.push(`${q.route} quarentena(s) de reroute`);
 if(q.pricingRoute)alerts.push(`${q.pricingRoute} quarentena(s) de pricing`);
 if(q.supplyKinds)alerts.push(`${q.supplyKinds} quarentena(s) de suprimentos`);
 if(d.routes.originUnavailable)alerts.push(`${d.routes.originUnavailable} aeronave(s) sem base operacional resolvida`);
 if(review.hold)alerts.push(`${review.hold} revisão(ões) de rota em HOLD`);
 if((d.departures.unknown||0)+(d.routes.unknown||0)+(d.pricing.unknown||0)>0)alerts.push('há resultado operacional incerto — nenhuma repetição automática');
 if(d.uiHealth.status!=='healthy'&&d.uiHealth.status!=='not_observed')alerts.push(`UI health: ${d.uiHealth.status}`);
 if(d.challenge?.detected)alerts.push('CAPTCHA/challenge detectado — execução interrompida sem tentativa de contorno');
 if((d.departures.timeBudgetHeld||0)>0)alerts.push(`${d.departures.timeBudgetHeld} aeronave(s) adiadas pelo orçamento de tempo; reavaliar na próxima execução`);
 if(d.fleet.collectionComplete===false&&Number.isSafeInteger(d.fleet.expected)&&d.fleet.expected>0)
   alerts.push(`coleta global incompleta: ${fmt(d.fleet.seen)}/${fmt(d.fleet.expected)}; ${fmt(d.fleet.individualVerified)} alvo(s) verificado(s) individualmente (cobertura parcial)`);
 if((d.departures.fuelHeld||0)>0)
   alerts.push(`${d.departures.fuelHeld} aeronave(s) retidas por Fuel insuficiente${fuel?.reason==='PRICE_ABOVE_LIMIT'&&Number.isSafeInteger(fuel.pricePer1000)&&Number.isSafeInteger(fuel.effectiveMax)?`; preço live ${fmt(fuel.pricePer1000)}/1k acima do teto ${fmt(fuel.effectiveMax)}/1k`:''}`);
 if(d.maintenance?.preventiveACheckRepairs==='held_safe')alerts.push(`manutenção em HOLD seguro: ${d.maintenance.holdReason||'motivo não informado'}`);
 if(d.campaign?.status==='unverified'||d.campaign?.allRequiredVerified===false)alerts.push('campanhas exigidas não confirmadas — decolagens bloqueadas');
 const lines=['# Airline Manager 4 — relatório operacional','',
  `> Run **#${d.run?.number||'n/d'}** · **${runStatus}** · modo **${mode}** · SHA \`${sha}\` · ${safe(d.generatedAt)}`,
  d.run?.url?`> [Abrir execução no GitHub Actions](${d.run.url})`:'','',
  '## Resumo executivo','',
  '| Área | Resultado | Evidência resumida |','| --- | --- | --- |',
  `| Bases | **${d.bases?.effective?.length??0}** ativas | ${d.bases?.effective?.length?d.bases.effective.map(safe).join(', '):'n/d'} · fonte ${safe(d.bases?.status||'n/d')} |`,
  `| ${d.fleet.scope==='FIRST_PAGE_ONLY'?'Página atual (sem inventário global)':'Frota (coleta antes das decolagens)'} | **${fmt(d.fleet.seen)}** vistas${d.fleet.collectionComplete===false&&Number.isSafeInteger(d.fleet.expected)?` de ${fmt(d.fleet.expected)} (parcial)`:''} | ${d.fleet.collectionComplete===false?`${fmt(d.fleet.individualVerified)} verificadas individualmente · estado global não confirmado`:`${fmt(d.fleet.inflight)} em voo · ${fmt(d.fleet.ready)} prontas · ${fmt(d.fleet.unavailable)} indisponíveis`} |`,
  `| Demanda | **${fmt(d.demand.sufficient)}/${fmt(d.demand.evaluated)}** suficientes | insuficientes ${fmt(d.demand.insufficient)} · indisponíveis ${fmt(d.demand.unavailable)} · coleta ${d.demand.collectionComplete===true?'completa':d.demand.collectionComplete===false?'incompleta':'n/d'} |`,
  `| Decolagens | **${fmt(d.departures.departed)}/${fmt(d.departures.evaluated)}** confirmadas | retidas ${fmt(d.departures.held)} (por tempo: ${fmt(d.departures.timeBudgetHeld)}) · incertas ${fmt(d.departures.unknown)} |`,
  `| Pricing | **${fmt(d.pricing.adjusted)}** ajustadas | ${fmt(d.pricing.unchanged)} no alvo · incertas ${fmt(d.pricing.unknown)}${d.pricing.phaseHoldReason?` · fase: ${safe(d.pricing.phaseHoldReason)}`:''} |`,
  `| Rotas | **${fmt(d.routes.rerouted)}** reroutes confirmados | revisão: KEEP ${fmt(review.keep)} · HOLD ${fmt(review.hold)} · WOULD_REROUTE ${fmt(review.wouldReroute)} |`,
  `| UI | **${safe(d.uiHealth.status)}** | checks não saudáveis: ${fmt(d.uiHealth.unhealthyChecks)} |`,
  `| Orçamento de tempo | **${d.timeBudget.blocked===0?'OK':'BLOQUEIOS'}** | ${fmt(d.timeBudget.blocked)} fase(s) bloqueada(s) de ${fmt(d.timeBudget.decisions)} |`,'',
  '## Suprimentos e módulos','',
  `- ${supplyText('Fuel',fuel)}.`,`- ${supplyText('CO₂',co2)}.`,
  d.postDispatchSupplies?.observed
    ? `- **Reposição após decolagens:** ${supplyText('Fuel',d.postDispatchSupplies.fuel)}; ${supplyText('CO₂',d.postDispatchSupplies.co2)}.`
    : '- **Reposição após decolagens:** não executada.',
  d.fuelPriceWindow?.nextEligible
    ? `- **Proxima janela estimada de Fuel (nao verificada):** ${d.fuelPriceWindow.nextEligible.localDate} ${d.fuelPriceWindow.nextEligible.localTime} UTC-3, referencia ${fmt(d.fuelPriceWindow.nextEligible.pricePer1000)}/1k; agora ${fmt(d.fuelPriceWindow.currentPricePer1000)}/1k; teto configurado ${fmt(d.fuelPriceWindow.configuredMax)}/1k, teto efetivo ${fmt(d.fuelPriceWindow.effectiveMax)}/1k; diferenca potencial ${fmt(d.fuelPriceWindow.nextEligible.savingVsCurrentPer1000)}/1k (${d.fuelPriceWindow.nextEligible.savingVsCurrentPercent??'n/d'}%). **Exige preco live para comprar.**`
    : '- **Janela estimada de Fuel:** sem horario listado elegivel nas proximas 24h, ou referencia indisponivel. A compra depende do preco live.',
  `- Manutenção/A-check/reparos: **${safe(d.maintenance.preventiveACheckRepairs)}**${d.maintenance.holdReason?` — ${safe(d.maintenance.holdReason)}`:d.maintenance.evidence?` — avaliadas ${fmt(d.maintenance.evidence.evaluated)}, selecionadas ${fmt(d.maintenance.evidence.selected)}, bulk check ${d.maintenance.evidence.bulkCheckExecuted===true?'executado':d.maintenance.evidence.bulkCheckExecuted===false?'não necessário':'n/d'}, reparo elegível ${d.maintenance.evidence.repairEligible===true?'sim':d.maintenance.evidence.repairEligible===false?'não':'n/d'}`:''}.`,
  `- Campanhas: **${safe(d.campaign.status)}**${d.campaign.evidence?.ecoFriendly?` — Eco ${d.campaign.evidence.ecoFriendly.verifiedActive===true?'✅':'❌'} · Reputation ${d.campaign.evidence.airlineReputation?.required===false?'n/a':d.campaign.evidence.airlineReputation?.verifiedActive===true?'✅':'❌'} · departure ${d.campaign.departureAuthorized===true?'autorizado':'bloqueado'}`:''}.`,'',
  '## Segurança e atenção','',
  alerts.length?alerts.map(x=>`- ⚠️ ${safe(x)}`).join('\n'):'- ✅ Nenhum alerta agregado adicional neste run.','',
  `Quarentenas persistentes — decolagem **${q.departure}** · reroute **${q.route}** · pricing **${q.pricingRoute}** · suprimentos **${q.supplyKinds}**.`,'',
  '## Estados operacionais','',
  '| Estado | Quantidade |','| --- | ---: |',
  `| NORMAL | ${s.NORMAL} |`,`| AGUARDANDO_DEMANDA | ${s.AGUARDANDO_DEMANDA} |`,`| AGUARDANDO_RECURSO | ${s.AGUARDANDO_RECURSO} |`,
  `| DADOS_INDISPONIVEIS | ${s.DADOS_INDISPONIVEIS} |`,`| QUARENTENA_DECOLAGEM | ${s.QUARENTENA_DECOLAGEM} |`,`| ORIGEM_OPERACIONAL_INDEFINIDA | ${s.ORIGEM_OPERACIONAL_INDEFINIDA} |`,
  `| PRECISA_REVISAR_ROTA | ${s.PRECISA_REVISAR_ROTA} |`,`| PRECISA_REVISAR_PRECO | ${s.PRECISA_REVISAR_PRECO} |`,
  `| MANUTENCAO | ${s.MANUTENCAO} |`,`| PRONTA_PARA_DECOLAR | ${s.PRONTA_PARA_DECOLAR} |`,'',
  d.fleet.collectionComplete===false&&d.fleet.individualVerified>0?'Estados da frota global indisponíveis; consulte os resultados individuais no relatório de decolagens.':'',
  '### Aeronaves que exigem atenção','',
  attention.length?'| Aeronave | Estado | Motivo |\n| --- | --- | --- |\n'+attention.map(x=>`| ${safe(x.registration)} | ${x.state} | ${safe(x.reason)} |`).join('\n'):(d.fleet.collectionComplete===false?'Estado global indisponível; não é possível afirmar ausência de aeronaves que exigem atenção.':'Nenhuma aeronave fora do estado NORMAL neste run.'),'',
  '## Relatórios detalhados','',
  'Os detalhes completos permanecem no artifact **demand-report** (JSON + Markdown), incluindo demanda por aeronave, route research, pricing, reroute, supplies, histórico de voo, UI health e orçamento de tempo. O artifact **playwright-report** mantém os logs técnicos da execução.','',
  '_O painel não transforma ausência de evidência em zero e não remove os bloqueios fail-closed. Dados operacionais detalhados permanecem nos artifacts._',''];
 return lines.filter((x,i)=>x!==''||lines[i-1]!=='').join('\n');
}
function selfTest(){
 const dir=fs.mkdtempSync('/tmp/am4-dashboard-');
 fs.writeFileSync(path.join(dir,'fleet-observations.json'),JSON.stringify({aircraft:[
  {aircraftId:'1',registration:'A',routeId:'1',state:'ready'},{aircraftId:'2',registration:'B',routeId:'2',state:'inflight'},
  {aircraftId:'3',registration:'C',routeId:'3',state:'ready'},{aircraftId:'4',registration:'D',routeId:'4',state:'ready'},
  {aircraftId:'5',registration:'E',routeId:'5',state:'ready'},{aircraftId:'6',registration:'F',routeId:'6',state:'ready'},
  {aircraftId:'7',registration:'G',routeId:'7',state:'ready'},{aircraftId:'8',registration:'H',routeId:'8',state:'ready'},
  {aircraftId:'9',registration:'I',routeId:'9',state:'inflight',detailsVerified:true,operationalOrigin:null,originResolution:{source:'unavailable',reason:'Nenhum aeroporto da rota pertence as bases configuradas.'}},
  {aircraftId:'10',registration:'J',routeId:'10',state:'unavailable',detailsVerified:false,operationalOrigin:null,originResolution:{source:'unavailable',reason:'Detalhes indisponiveis.'}},
  {aircraftId:'11',registration:'K',routeId:'11',state:'inflight',detailsVerified:false,operationalOrigin:null,originResolution:{source:'unavailable',reason:'Detalhes nao coletados nesta run.'}}]}));
 fs.writeFileSync(path.join(dir,'owned-airline-bases.json'),JSON.stringify({status:'observed',source:'research_main.php#hubSelect',reason:'LIVE_OWNED_HUBS_CROSSCHECKED_BY_AIRPORT_SOURCE_ID',effectiveBases:['XAP','GRU','DTW','TXL']}));
 fs.writeFileSync(path.join(dir,'demand-report.json'),JSON.stringify({summary:{fleetSeen:11}}));
 fs.writeFileSync(path.join(dir,'execution-report.json'),JSON.stringify({summary:{departed:0,held:3,unknown:1},entries:[
  {aircraftId:'1',status:'held',reason:'DEMAND_BELOW_THRESHOLD',demand:{decision:'hold_insufficient'}},
  {aircraftId:'3',status:'outcome_unknown',reason:'NO_RETRY_AFTER_CLICK_ATTEMPT:CONFIRM_STATE_NOT_INFLIGHT'},
  {aircraftId:'4',status:'held',reason:'PERSISTED_UNCERTAIN_DEPARTURE_BLOCK'},
  {aircraftId:'5',status:'held',reason:'RUN_TIME_BUDGET_EXHAUSTED_BEFORE_MUTATION'},
  {aircraftId:'6',status:'held',reason:'FUEL_STOCK_INSUFFICIENT_BY_VERIFIED_HISTORY'}]}));
 fs.writeFileSync(path.join(dir,'route-execution.json'),JSON.stringify({summary:{evaluated:0,rerouted:0,held:0,unknown:0},entries:[]}));
 fs.writeFileSync(path.join(dir,'pricing-execution.json'),JSON.stringify({summary:{evaluated:0,adjusted:0,unchanged:0,held:0,unknown:0},phaseHoldReason:'PRICING_INITIAL_COLLECTION_INCOMPLETE'}));
 fs.writeFileSync(path.join(dir,'candidate-data.json'),JSON.stringify({routeDecisions:[
  {aircraftId:'7',decision:'hold',reason:'NO_VERIFIED_VARIABLE_CYCLE_COMPARISON'},
  {aircraftId:'8',decision:'keep_route',reason:'NO_INSPECTED_CANDIDATE_PROVES_CONSERVATIVE_DOMINANCE'}
 ]}));
 fs.writeFileSync(path.join(dir,'operational-modules.json'),JSON.stringify({schemaVersion:1,maintenance:{status:'completed_observed',observedAt:'2026-01-01T00:00:00.000Z',evidence:{evaluated:22,selected:1,bulkCheckExecuted:true,repairEligible:false}},campaign:{status:'verified_active',observedAt:'2026-01-01T00:00:00.000Z',evidence:{allRequiredVerified:true,departureAuthorized:true,ecoFriendly:{required:true,verifiedActive:true,status:'already_active'},airlineReputation:{required:true,verifiedActive:true,status:'already_active'}}}}));
 fs.writeFileSync(path.join(dir,'journal.json'),JSON.stringify({schemaVersion:1,scope:'x',entries:[],events:[
  {type:'departure-uncertain',aircraftId:'2',routeId:'2'},
  {type:'route-uncertain',aircraftId:'3'},
  {type:'pricing-uncertain',routeId:'5'},
  {type:'supply-uncertain',kind:'co2',observedAt:'2026-01-01T00:00:00.000Z'}
 ],supplyObservations:[
  {type:'supply-observation',kind:'co2',observedAt:'2026-01-01T01:00:00.000Z'}
 ]}));
 const {dashboard,states}=build(dir,path.join(dir,'missing.log'),path.join(dir,'journal.json'));
 assert.deepEqual(dashboard.bases,{status:'observed',effective:['XAP','GRU','DTW','TXL'],source:'research_main.php#hubSelect',reason:'LIVE_OWNED_HUBS_CROSSCHECKED_BY_AIRPORT_SOURCE_ID'});assert.equal(dashboard.fleet.seen,11);assert.equal(dashboard.operationalStates.AGUARDANDO_DEMANDA,1);assert.equal(dashboard.operationalStates.DADOS_INDISPONIVEIS,1);assert.equal(dashboard.departures.fuelHeld,1);
 assert.equal(dashboard.operationalStates.PRECISA_REVISAR_ROTA,2);assert.equal(dashboard.operationalStates.QUARENTENA_DECOLAGEM,2);assert.equal(dashboard.operationalStates.ORIGEM_OPERACIONAL_INDEFINIDA,1);assert.equal(dashboard.operationalStates.PRECISA_REVISAR_PRECO,1);assert.equal(dashboard.operationalStates.PRONTA_PARA_DECOLAR,1);assert.equal(dashboard.operationalStates.AGUARDANDO_RECURSO,1);
 assert.deepEqual(dashboard.routes.reviewDecisions,{keep:1,hold:1,wouldReroute:0,unavailable:0});
 assert.equal(dashboard.routes.originUnavailable,1);assert.equal(dashboard.pricing.phaseHoldReason,'PRICING_INITIAL_COLLECTION_INCOMPLETE');
 assert.deepEqual(dashboard.quarantines,{departure:1,route:1,pricingRoute:1,supplyKinds:0});
 assert.equal(dashboard.departures.timeBudgetHeld,1);
 assert.ok(markdown(dashboard,[]).includes('1 aeronave(s) adiadas pelo orçamento de tempo'));
 assert.equal(dashboard.maintenance.preventiveACheckRepairs,'completed_observed');assert.deepEqual(dashboard.maintenance.evidence,{evaluated:22,selected:1,bulkCheckExecuted:true,repairEligible:false});assert.equal(dashboard.campaign.status,'verified_active');assert.equal(dashboard.campaign.allRequiredVerified,true);assert.equal(dashboard.campaign.departureAuthorized,true);
 fs.writeFileSync(path.join(dir,'operational-modules.json'),JSON.stringify({schemaVersion:1,maintenance:{status:'held_safe',observedAt:'2026-01-01T00:00:00.000Z',evidence:{reason:'UI_CONTROL_OBSCURED',mutationAuthorized:false}}}));
 const held=build(dir,path.join(dir,'missing.log'),path.join(dir,'journal.json')).dashboard;
 assert.equal(held.maintenance.preventiveACheckRepairs,'held_safe');assert.equal(held.maintenance.holdReason,'UI_CONTROL_OBSCURED');
 assert.ok(markdown(held,[]).includes('manutenção em HOLD seguro: UI_CONTROL_OBSCURED'));
 fs.writeFileSync(path.join(dir,'operational-modules.json'),JSON.stringify({schemaVersion:1,campaign:{status:'unverified',observedAt:'2026-01-01T00:00:00.000Z',evidence:{allRequiredVerified:false,departureAuthorized:false,ecoFriendly:{required:true,verifiedActive:false,status:'unverified'},airlineReputation:{required:true,verifiedActive:true,status:'already_active'}}}}));
 const campaignHeld=build(dir,path.join(dir,'missing.log'),path.join(dir,'journal.json')).dashboard;
 assert.equal(campaignHeld.campaign.status,'unverified');assert.equal(campaignHeld.campaign.departureAuthorized,false);
 assert.ok(markdown(campaignHeld,[]).includes('campanhas exigidas não confirmadas'));
 assert.equal(dashboard.uiHealth.status,'not_observed');assert.equal(dashboard.timeBudget.blocked,0);const md=markdown(dashboard,states);assert.ok(md.includes('Resumo executivo'));assert.ok(md.includes('Frota (coleta antes das decolagens)'));assert.ok(md.includes('Aeronaves que exigem atenção'));assert.ok(md.includes('Relatórios detalhados'));
 assert.deepEqual(states.find(x=>x.aircraftId==='2'),{aircraftId:'2',registration:'B',state:'QUARENTENA_DECOLAGEM',reason:'PERSISTED_UNCERTAIN_DEPARTURE_BLOCK',observedFleetState:'inflight'});
 assert.deepEqual(states.find(x=>x.aircraftId==='3'),{aircraftId:'3',registration:'C',state:'PRECISA_REVISAR_ROTA',reason:'PERSISTED_UNCERTAIN_ROUTE_BLOCK',observedFleetState:'ready'});
 assert.deepEqual(states.find(x=>x.aircraftId==='4'),{aircraftId:'4',registration:'D',state:'QUARENTENA_DECOLAGEM',reason:'PERSISTED_UNCERTAIN_DEPARTURE_BLOCK',observedFleetState:'ready'});
 assert.deepEqual(states.find(x=>x.aircraftId==='5'),{aircraftId:'5',registration:'E',state:'PRECISA_REVISAR_PRECO',reason:'PERSISTED_UNCERTAIN_PRICING_BLOCK',observedFleetState:'ready'});
 assert.deepEqual(states.find(x=>x.aircraftId==='6'),{aircraftId:'6',registration:'F',state:'AGUARDANDO_RECURSO',reason:'FUEL_STOCK_INSUFFICIENT_BY_VERIFIED_HISTORY',observedFleetState:'ready'});
 assert.deepEqual(states.find(x=>x.aircraftId==='7'),{aircraftId:'7',registration:'G',state:'PRECISA_REVISAR_ROTA',reason:'ROUTE_REVIEW_HOLD:NO_VERIFIED_VARIABLE_CYCLE_COMPARISON',observedFleetState:'ready'});
 assert.deepEqual(states.find(x=>x.aircraftId==='8'),{aircraftId:'8',registration:'H',state:'PRONTA_PARA_DECOLAR',reason:'READY_OBSERVED_NO_DEPARTURE_RESULT',observedFleetState:'ready'});
 assert.deepEqual(states.find(x=>x.aircraftId==='9'),{aircraftId:'9',registration:'I',state:'ORIGEM_OPERACIONAL_INDEFINIDA',reason:'ORIGIN_NOT_REGISTERED',observedFleetState:'inflight'});
 assert.deepEqual(states.find(x=>x.aircraftId==='10'),{aircraftId:'10',registration:'J',state:'DADOS_INDISPONIVEIS',reason:'DETAILS_UNVERIFIED',observedFleetState:'unavailable'});
 assert.deepEqual(states.find(x=>x.aircraftId==='11'),{aircraftId:'11',registration:'K',state:'NORMAL',reason:'INFLIGHT_OBSERVED',observedFleetState:'inflight'});
 // Regression: an incomplete global fleet must not erase individually verified
 // Fuel holds or pretend that zero global snapshots means zero observed routes.
 fs.rmSync(path.join(dir,'fleet-observations.json'));
 fs.writeFileSync(path.join(dir,'demand-report.json'),JSON.stringify({summary:{fleetSeen:0}}));
 fs.writeFileSync(path.join(dir,'global-fleet-fallback.json'),JSON.stringify({globalComplete:false,observed:39,expected:154}));
 fs.writeFileSync(path.join(dir,'execution-report.json'),JSON.stringify({summary:{evaluated:2,departed:0,held:2,unknown:0},entries:[
  {aircraftId:'21',routeId:'121',registration:'R21',status:'held',reason:'FUEL_STOCK_INSUFFICIENT_BY_VERIFIED_HISTORY',demand:{aircraftId:'21',routeId:'121',state:'ready'}},
  {aircraftId:'22',routeId:'122',registration:'R22',status:'held',reason:'DEMAND_BELOW_THRESHOLD',demand:{aircraftId:'22',routeId:'122',state:'ready',decision:'hold_insufficient'}}]}));
 fs.writeFileSync(path.join(dir,'supply-report.json'),JSON.stringify({entries:[{kind:'fuel',status:'skipped',reason:'PRICE_ABOVE_LIMIT',before:{pricePer1000:740}}],adaptive:{fuel:{effectiveMax:550}}}));
 const partial=build(dir,path.join(dir,'missing.log'),path.join(dir,'journal.json')).dashboard;
 assert.equal(partial.fleet.seen,39);assert.equal(partial.fleet.expected,154);
 assert.equal(partial.fleet.collectionComplete,false);assert.equal(partial.fleet.individualVerified,2);
 assert.equal(partial.departures.fuelHeld,1);
 const partialMd=markdown(partial,[]);
 assert.ok(partialMd.includes('39** vistas de 154 (parcial)'));
 assert.ok(partialMd.includes('coleta global incompleta: 39/154; 2 alvo(s) verificado(s) individualmente'));
 assert.ok(partialMd.includes('1 aeronave(s) retidas por Fuel insuficiente; preço live 740/1k acima do teto 550/1k'));
 assert.ok(partialMd.includes('Estados da frota global indisponíveis'));
 assert.ok(partialMd.includes('| NORMAL | n/d |'));
 assert.ok(partialMd.includes('não é possível afirmar ausência de aeronaves que exigem atenção'));
 fs.rmSync(dir,{recursive:true,force:true});console.log('company-dashboard self-test ok');
}
if(require.main===module){
 if(process.argv.includes('--self-test'))selfTest();
 else{
  const dir=process.argv[2]||'test-results/demand',out=build(dir);
  fs.mkdirSync(dir,{recursive:true});
  fs.writeFileSync(path.join(dir,'company-dashboard.json'),JSON.stringify(out.dashboard,null,2)+'\n');
  fs.writeFileSync(path.join(dir,'operational-states.json'),JSON.stringify({schemaVersion:1,generatedAt:out.dashboard.generatedAt,states:out.states},null,2)+'\n');
  fs.writeFileSync(path.join(dir,'company-dashboard.md'),markdown(out.dashboard,out.states));
 }
}
module.exports={build,markdown};
