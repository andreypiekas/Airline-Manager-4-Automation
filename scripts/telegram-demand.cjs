// Operational summary. Aircraft registrations appear only for verified shared routes; never include credentials or account balances.
const fs = require('node:fs');
const https = require('node:https');

function message(report) {
  const s = report.summary;
  if (!s || !['evaluated', 'sufficient', 'insufficient', 'unavailable'].every(k => Number.isSafeInteger(s[k]) && s[k] >= 0)) throw new Error('invalid report');
  if (report.collectionComplete && s.insufficient === 0 && s.unavailable === 0) return null;
  return 'AM4 demanda (simulacao): avaliadas '+s.evaluated+'; suficientes '+s.sufficient+'; insuficientes '+s.insufficient+'; indisponiveis '+s.unavailable+'; coleta '+(report.collectionComplete ? 'completa' : 'incompleta')+'. Nenhuma operacao executada pelo modulo.';
}

const read=(dir,name)=>{try{return JSON.parse(fs.readFileSync(dir+'/'+name,'utf8'));}catch{return null;}};

function importantMessage(dir='test-results/demand',botResult=process.env.BOT_RESULT,journalPath='.am4-state/github/return-journal.json'){
  const events=[];
  const ui=read(dir,'ui-health.json');
  const challenge=read(dir,'challenge-detected.json');
  const demand=read(dir,'demand-report.json');
  const route=read(dir,'route-execution.json');
  const execution=read(dir,'execution-report.json');
  const pricing=read(dir,'pricing-execution.json');
  const supply=read(dir,'supply-report.json');
  const candidate=read(dir,'candidate-data.json');
  const modules=read(dir,'operational-modules.json');
  if(botResult&&botResult!=='success')events.push('falha do run: '+botResult);
  if(ui?.status==='UI_CHANGE_DETECTED')events.push('UI_CHANGE_DETECTED em superficie critica');
  if(challenge?.detected===true)events.push('CAPTCHA/challenge detectado; execucao interrompida sem tentativa de contorno');
  if(modules?.maintenance?.status==='held_safe')events.push('manutencao em HOLD seguro: '+String(modules?.maintenance?.evidence?.reason||'SAFE_HOLD'));
  if(modules?.campaign?.status==='unverified'||modules?.campaign?.evidence?.allRequiredVerified===false)events.push('campanhas exigidas nao confirmadas; decolagens bloqueadas');
  const unknown=(name,r)=>{
    const n=r?.summary?.unknown;
    if(Number.isSafeInteger(n)&&n>0)events.push(name+' com resultado incerto: '+n);
    if(r?.halted===true)events.push(name+' interrompido por fail-safe');
  };
  unknown('decolagem',execution);
  unknown('reroute',route);
  unknown('pricing',pricing);
  if(supply?.halted===true)events.push('suprimentos interrompidos por fail-safe');
  const fuelHeld=(execution?.entries||[]).filter(x=>x?.status==='held'&&x?.reason==='FUEL_STOCK_INSUFFICIENT_BY_VERIFIED_HISTORY').length;
  if(fuelHeld>0)events.push('decolagens retidas por combustivel insuficiente verificado: '+fuelHeld);
  const reroutePricingHeld=(execution?.entries||[]).filter(x=>x?.status==='held'&&x?.reason==='REROUTE_PRICING_NOT_VERIFIED').length;
  if(reroutePricingHeld>0)events.push('aeronaves reroteadas aguardando pricing confirmado: '+reroutePricingHeld);
  const rerouted=route?.summary?.rerouted;
  if(Number.isSafeInteger(rerouted)&&rerouted>0)events.push('rotas alteradas e confirmadas: '+rerouted);
  if(Array.isArray(demand?.decisions)){
    const exhausted=demand.decisions.filter(x=>x?.decision==='hold_insufficient'&&x?.occupancyPercentage===0).length;
    if(exhausted>0)events.push('demanda esgotada observada: '+exhausted);
  }
  const hours=Number(process.env.HOURS_CHECK||'20');
  const wear=Number(process.env.REPAIR_WEAR||'30');
  if(candidate?.maintenance?.status==='observed'&&candidate.maintenance.complete===true&&Number.isFinite(hours)&&Number.isFinite(wear)){
    const critical=(candidate.maintenance.aircraft||[]).filter(x=>Number.isFinite(x.hoursToCheck)&&Number.isFinite(x.wearPercentage)&&(x.hoursToCheck<=hours||x.wearPercentage>=wear)).length;
    if(critical>0)events.push('manutencao critica pela politica verificada: '+critical);
  }
  const fuel=(supply?.entries||[]).find(x=>x?.kind==='fuel');
  const policy=supply?.adaptive?.fuel;
  if(policy?.source==='verified-live-history'&&Number.isSafeInteger(policy.historicalReference)&&fuel?.before&&Number.isSafeInteger(fuel.before.pricePer1000)&&fuel.before.pricePer1000<=policy.historicalReference&&['purchased','would_buy'].includes(fuel.status))events.push('combustivel materialmente barato vs historico verificado');
  const journal=(()=>{try{return JSON.parse(fs.readFileSync(journalPath,'utf8'));}catch{return null;}})();
  const holdMinutes=Number(process.env.DEMAND_PROLONGED_HOLD_MINUTES||'180');
  if(journal&&Number.isFinite(holdMinutes)&&holdMinutes>0){
    const departures=journal.events||[];
    const holds=journal.holdObservations||[];
    const groups=new Map();
    for(const x of holds){
      const k=x.aircraftId+':'+x.routeId,a=groups.get(k)||[];
      a.push(x);groups.set(k,a);
    }
    let prolonged=0;
    for(const [k,a] of groups){
      const [aircraftId,routeId]=k.split(':');
      const lastDep=Math.max(0,...departures.filter(x=>x.aircraftId===aircraftId&&x.routeId===routeId).map(x=>Date.parse(x.observedAt)||0));
      const active=a.filter(x=>(Date.parse(x.observedAt)||0)>lastDep).sort((x,y)=>Date.parse(x.observedAt)-Date.parse(y.observedAt));
      if(active.length>=2&&(Date.parse(active.at(-1).observedAt)-Date.parse(active[0].observedAt))/60000>=holdMinutes)prolonged++;
    }
    if(prolonged>0)events.push('holds prolongados com duracao verificada: '+prolonged);
  }
  if(!events.length)return null;
  return 'AM4 alerta: '+[...new Set(events)].join('; ')+'.';
}

function fuelWindowMessage(window) {
  if(!window || !window.nextEligible)return null;
  const p=window.nextEligible;
  const fmt=v=>Number.isSafeInteger(v)?String(v):'n/d';
  const percent=Number.isFinite(p.savingVsCurrentPercent)?String(p.savingVsCurrentPercent)+'%':'n/d';
  const confidence=window.status==='ocr-unverified'?'referencia OCR NAO verificada':'referencia sem garantia';
  const now=window.currentWithinEffectiveLimit===true?'atual ja atende teto':'aguardar cotacao live';
  return '⛽ Proximo Fuel estimado: '+p.localDate+' '+p.localTime+' (UTC-3) $'+fmt(p.pricePer1000)+'/1k'
    +' | atual $'+fmt(window.currentPricePer1000)+'/1k | limite $'+fmt(window.configuredMax)
    +(window.effectiveMax!==window.configuredMax?' (efetivo $'+fmt(window.effectiveMax)+')':'')
    +' | economia potencial $'+fmt(p.savingVsCurrentPer1000)+'/1k ('+percent+')'
    +' | '+confidence+'; '+now+'. Compra so com preco live e demais validacoes.';
}

function sharedRouteMessage(dir) {
  const report=read(dir,'demand-report.json');
  if(!Array.isArray(report?.decisions))return null;
  const knownAircraft=new Map(),knownRoutes=new Map();
  for(const a of report.decisions){
    if(!/^[1-9]\\d*$/.test(a?.aircraftId||'')||!/^[1-9]\\d*$/.test(a?.routeId||''))continue;
    if(!/^[A-Z0-9]{3}$/.test(a?.from||'')||!/^[A-Z0-9]{3}$/.test(a?.to||'')||a.from===a.to)continue;
    const aId=a.aircraftId,rId=a.routeId;
    if(knownAircraft.has(aId)||knownRoutes.has(rId)){
      // A repeated rendered identity is not a second plane. Never report it
      // as a legitimate shared route or silently count its demand twice.
      knownAircraft.set(aId,null);knownRoutes.set(rId,null);
      continue;
    }
    knownAircraft.set(aId,a);knownRoutes.set(rId,a);
  }
  const groups=new Map();
  for(const [aId,a] of knownAircraft){
    if(!a||knownRoutes.get(a.routeId)!==a)continue;
    const key=a.from+'→'+a.to,group=groups.get(key)||[];
    const label=String(a.registration||aId).replace(/[\\r\\n\\t<>|]/g,' ').trim().slice(0,55)||aId;
    group.push(label);groups.set(key,group);
  }
  const shared=[...groups].filter(([,planes])=>planes.length>1).sort(([a],[b])=>a.localeCompare(b));
  if(!shared.length)return null;
  const items=shared.slice(0,5).map(([route,planes])=>route+': '+planes.slice(0,6).join(', ')+(planes.length>6?' +'+(planes.length-6):''));
  return 'Rotas compartilhadas'+(report.collectionComplete===true?'':' (coleta parcial)')+': '+items.join(' | ')+(shared.length>5?' | +'+(shared.length-5)+' outras':'');
}

function departureValueMessage(dir) {
  const execution=read(dir,'execution-report.json');
  if(!execution||execution.dryRun!==false||!Array.isArray(execution.entries))
    return 'Receita bruta estimada das decolagens: n/d (sem comprovantes de partidas)';
  const departed=execution.entries.filter(x=>x?.status==='departed');
  if(!Number.isSafeInteger(execution.summary?.departed)||departed.length!==execution.summary.departed)
    return 'Receita bruta estimada das decolagens: n/d (resumo inconsistente)';
  const valid=departed.filter(x=>Number.isSafeInteger(x.estimatedGrossTicketRevenue)&&x.estimatedGrossTicketRevenue>=0);
  const total=valid.reduce((n,x)=>n+x.estimatedGrossTicketRevenue,0);
  if(valid.length!==departed.length||!Number.isSafeInteger(total))
    return 'Receita bruta estimada das decolagens: n/d (tarifa verificada em '+valid.length+'/'+departed.length+')';
  return 'Receita bruta estimada das decolagens: 
  const semi=read(dir,'semi-automatic-summary.json');
  if(process.env.AUTOMATION_MODE!=='semi-automatic'||semi?.mode!=='semi-automatic')return null;
  const n=v=>Number.isSafeInteger(v)?String(v):'n/d';
  const price=v=>Number.isSafeInteger(v)?'$'+v+'/1k':'n/d';
  const lines=[
    '🟡 AM4 • MODO SEMIAUTOMÁTICO',
    'Prontas: '+n(semi.fleet?.ready)+' | em voo: '+n(semi.fleet?.inflight)+' | frota: '+n(semi.fleet?.seen),
    'Demanda: '+n(semi.demand?.sufficient)+'/'+n(semi.demand?.evaluated)+' suficientes',
    'Fuel: '+price(semi.supplies?.fuel?.pricePer1000)+' | CO₂: '+price(semi.supplies?.co2?.pricePer1000),
    'Pricing: '+n(semi.pricing?.wouldAdjust)+' ajustes sugeridos | recomendações sem preço atual: '+n(semi.pricing?.recommendationOnly),
    'Rotas: '+n(semi.routes?.wouldReroute)+' candidata(s) a reroute',
    'Nenhuma operação foi executada.',
    'Para executar: GitHub Actions → Run workflow → marque confirm_semiautomatic_execution.'
  ];
  const forecastLine=fuelWindowMessage(read(dir,'company-dashboard.json')?.fuelPriceWindow);
  if(forecastLine)lines.splice(4,0,forecastLine);
  const repeated=sharedRouteMessage(dir);
  if(repeated)lines.push(repeated);
  if(process.env.WORKFLOW_URL)lines.push('Abrir Actions: '+process.env.WORKFLOW_URL);
  return lines.join('\n').slice(0,3500);
}

function runSummaryMessage(dir='test-results/demand',botResult=process.env.BOT_RESULT){
  const semi=semiAutomaticMessage(dir);
  if(semi)return semi;
  const d=read(dir,'company-dashboard.json');
  const status=d?.run?.stale?'IGNORADA':botResult==='success'?'SUCESSO':botResult==='failure'?'FALHA':botResult==='skipped'?'IGNORADA':String(botResult||'DESCONHECIDO').toUpperCase();
  const n=v=>Number.isSafeInteger(v)?String(v):'n/d';
  const fmt=v=>Number.isSafeInteger(v)?v.toLocaleString('en-US'):'n/d';
  const lines=['✈️ AM4 • '+status+(process.env.GITHUB_RUN_NUMBER?' • run #'+process.env.GITHUB_RUN_NUMBER:'')];
  if(Array.isArray(d?.bases?.effective)&&d.bases.effective.length)lines.push('Bases: '+d.bases.effective.join(', ')+(d.bases.status==='observed'?' • live':' • fallback'));
  if(d?.fleet)lines.push('Frota: '+n(d.fleet.seen)+' | voo '+n(d.fleet.inflight)+' | prontas '+n(d.fleet.ready));
  if(d?.demand)lines.push('Demanda: '+n(d.demand.sufficient)+'/'+n(d.demand.evaluated)+' suficientes | insuf. '+n(d.demand.insufficient)+' | indispon. '+n(d.demand.unavailable));
  if(d?.departures){
    lines.push('Decolagens: '+n(d.departures.departed)+'/'+n(d.departures.evaluated)+' confirmadas | retidas '+n(d.departures.held)+' | incertas '+n(d.departures.unknown));
    lines.push(departureValueMessage(dir));
  }
  const repeated=sharedRouteMessage(dir);
  if(repeated)lines.push(repeated);
  if(d?.pricing)lines.push('Pricing: '+n(d.pricing.adjusted)+' ajustadas | '+n(d.pricing.unchanged)+' no alvo | incertas '+n(d.pricing.unknown));
  if(d?.routes){
    const r=d.routes.reviewDecisions||{},dr=d.routes.demandTriggered||{};
    lines.push('Rotas: '+n(d.routes.rerouted)+' reroutes | revisão KEEP '+n(r.keep)+' / HOLD '+n(r.hold)+' / candidato '+n(r.wouldReroute)+
      ' | demanda→pesquisa '+n(dr.observed)+'/'+n(dr.eligible));
  }
  const supply=(label,x)=>{
    if(!x)return label+': n/d';
    const bits=[x.status];
    if(Number.isSafeInteger(x.pricePer1000))bits.push(fmt(x.pricePer1000)+'/1k');
    if(Number.isSafeInteger(x.quantity)&&x.quantity>0)bits.push('qtd '+fmt(x.quantity));
    return label+': '+bits.join(' • ');
  };
  if(d?.supplies)lines.push('Suprimentos: '+supply('Fuel',d.supplies.fuel)+' | '+supply('CO₂',d.supplies.co2));
  const fuelForecastLine=fuelWindowMessage(d?.fuelPriceWindow);
  if(fuelForecastLine)lines.push(fuelForecastLine);
  if(d?.campaign){
    const eco=d.campaign.evidence?.ecoFriendly?.verifiedActive===true?'✅':d.campaign.evidence?.ecoFriendly?'❌':'n/d';
    const rep=d.campaign.evidence?.airlineReputation?.required===false?'n/a':d.campaign.evidence?.airlineReputation?.verifiedActive===true?'✅':d.campaign.evidence?.airlineReputation?'❌':'n/d';
    const gate=d.campaign.departureAuthorized===true?'✅':d.campaign.departureAuthorized===false?'⛔':'n/d';
    lines.push('Campanhas: Eco '+eco+' | Reputation '+rep+' | decolagens '+gate);
  }
  if(d?.quarantines)lines.push('Segurança: quarentenas D'+n(d.quarantines.departure)+' R'+n(d.quarantines.route)+' P'+n(d.quarantines.pricingRoute)+' S'+n(d.quarantines.supplyKinds)+' | UI '+(d.uiHealth?.status||'n/d'));
  if(process.env.RUN_URL)lines.push('Run: '+process.env.RUN_URL);
  return lines.join('\n').slice(0,3500);
}

async function main() {
  if (process.env.DEMAND_TELEGRAM_ENABLED !== 'true') return;
  const token = process.env.TELEGRAM_BOT_TOKEN, chatId = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chatId) { console.log('[Demand] Telegram nao configurado.'); return; }
  const summary = runSummaryMessage('test-results/demand',process.env.BOT_RESULT);
  const alert = importantMessage('test-results/demand',process.env.BOT_RESULT);
  const text = alert ? summary+'\n'+alert : summary;
  const payload={chat_id:chatId,text};
  if(process.env.AUTOMATION_MODE==='semi-automatic'&&/^https:\/\/github\.com\//.test(process.env.WORKFLOW_URL||'')){
    payload.reply_markup={inline_keyboard:[[{text:'Abrir GitHub Actions',url:process.env.WORKFLOW_URL}]]};
  }
  const body = JSON.stringify(payload);
  await new Promise((resolve, reject) => {
    const req = https.request({ hostname: 'api.telegram.org', path: '/bot'+token+'/sendMessage', method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }, timeout: 15000 }, res => {
      let raw = '';
      res.setEncoding('utf8');
      res.on('data', chunk => { if (raw.length < 4096) raw += chunk; });
      res.on('end', () => {
        if (res.statusCode === 200) return resolve();
        let description = '';
        try {
          const parsed = JSON.parse(raw);
          if (typeof parsed.description === 'string') description = parsed.description.replace(/[\r\n\t]+/g, ' ').slice(0, 180);
        } catch {}
        reject(new Error('Telegram API '+(res.statusCode || 'erro')+(description ? ': '+description : '')));
      });
    });
    req.on('timeout', () => req.destroy(new Error('Telegram timeout')));
    req.on('error', error => reject(new Error(error?.message === 'Telegram timeout' ? 'Telegram timeout' : 'Telegram network error')));
    req.end(body);
  });
}

if (require.main === module) main().catch(error => {
  console.error('[Demand] '+String(error?.message || 'Telegram notification failed'));
  console.log('::warning::Falha ao enviar notificacao Telegram; consulte o log seguro desta etapa.');
  process.exitCode = 1;
});

module.exports = { message, importantMessage, runSummaryMessage, fuelWindowMessage, sharedRouteMessage, departureValueMessage };
+total.toLocaleString('en-US')+' ('+departed.length+' confirmadas; nao e lucro nem receita contabil)';
}

function semiAutomaticMessage(dir){
  const semi=read(dir,'semi-automatic-summary.json');
  if(process.env.AUTOMATION_MODE!=='semi-automatic'||semi?.mode!=='semi-automatic')return null;
  const n=v=>Number.isSafeInteger(v)?String(v):'n/d';
  const price=v=>Number.isSafeInteger(v)?'$'+v+'/1k':'n/d';
  const lines=[
    '🟡 AM4 • MODO SEMIAUTOMÁTICO',
    'Prontas: '+n(semi.fleet?.ready)+' | em voo: '+n(semi.fleet?.inflight)+' | frota: '+n(semi.fleet?.seen),
    'Demanda: '+n(semi.demand?.sufficient)+'/'+n(semi.demand?.evaluated)+' suficientes',
    'Fuel: '+price(semi.supplies?.fuel?.pricePer1000)+' | CO₂: '+price(semi.supplies?.co2?.pricePer1000),
    'Pricing: '+n(semi.pricing?.wouldAdjust)+' ajustes sugeridos | recomendações sem preço atual: '+n(semi.pricing?.recommendationOnly),
    'Rotas: '+n(semi.routes?.wouldReroute)+' candidata(s) a reroute',
    'Nenhuma operação foi executada.',
    'Para executar: GitHub Actions → Run workflow → marque confirm_semiautomatic_execution.'
  ];
  const forecastLine=fuelWindowMessage(read(dir,'company-dashboard.json')?.fuelPriceWindow);
  if(forecastLine)lines.splice(4,0,forecastLine);
  if(process.env.WORKFLOW_URL)lines.push('Abrir Actions: '+process.env.WORKFLOW_URL);
  return lines.join('\n').slice(0,3500);
}

function runSummaryMessage(dir='test-results/demand',botResult=process.env.BOT_RESULT){
  const semi=semiAutomaticMessage(dir);
  if(semi)return semi;
  const d=read(dir,'company-dashboard.json');
  const status=d?.run?.stale?'IGNORADA':botResult==='success'?'SUCESSO':botResult==='failure'?'FALHA':botResult==='skipped'?'IGNORADA':String(botResult||'DESCONHECIDO').toUpperCase();
  const n=v=>Number.isSafeInteger(v)?String(v):'n/d';
  const fmt=v=>Number.isSafeInteger(v)?v.toLocaleString('en-US'):'n/d';
  const lines=['✈️ AM4 • '+status+(process.env.GITHUB_RUN_NUMBER?' • run #'+process.env.GITHUB_RUN_NUMBER:'')];
  if(Array.isArray(d?.bases?.effective)&&d.bases.effective.length)lines.push('Bases: '+d.bases.effective.join(', ')+(d.bases.status==='observed'?' • live':' • fallback'));
  if(d?.fleet)lines.push('Frota: '+n(d.fleet.seen)+' | voo '+n(d.fleet.inflight)+' | prontas '+n(d.fleet.ready));
  if(d?.demand)lines.push('Demanda: '+n(d.demand.sufficient)+'/'+n(d.demand.evaluated)+' suficientes | insuf. '+n(d.demand.insufficient)+' | indispon. '+n(d.demand.unavailable));
  if(d?.departures)lines.push('Decolagens: '+n(d.departures.departed)+'/'+n(d.departures.evaluated)+' confirmadas | retidas '+n(d.departures.held)+' | incertas '+n(d.departures.unknown));
  if(d?.pricing)lines.push('Pricing: '+n(d.pricing.adjusted)+' ajustadas | '+n(d.pricing.unchanged)+' no alvo | incertas '+n(d.pricing.unknown));
  if(d?.routes){
    const r=d.routes.reviewDecisions||{},dr=d.routes.demandTriggered||{};
    lines.push('Rotas: '+n(d.routes.rerouted)+' reroutes | revisão KEEP '+n(r.keep)+' / HOLD '+n(r.hold)+' / candidato '+n(r.wouldReroute)+
      ' | demanda→pesquisa '+n(dr.observed)+'/'+n(dr.eligible));
  }
  const supply=(label,x)=>{
    if(!x)return label+': n/d';
    const bits=[x.status];
    if(Number.isSafeInteger(x.pricePer1000))bits.push(fmt(x.pricePer1000)+'/1k');
    if(Number.isSafeInteger(x.quantity)&&x.quantity>0)bits.push('qtd '+fmt(x.quantity));
    return label+': '+bits.join(' • ');
  };
  if(d?.supplies)lines.push('Suprimentos: '+supply('Fuel',d.supplies.fuel)+' | '+supply('CO₂',d.supplies.co2));
  const fuelForecastLine=fuelWindowMessage(d?.fuelPriceWindow);
  if(fuelForecastLine)lines.push(fuelForecastLine);
  if(d?.campaign){
    const eco=d.campaign.evidence?.ecoFriendly?.verifiedActive===true?'✅':d.campaign.evidence?.ecoFriendly?'❌':'n/d';
    const rep=d.campaign.evidence?.airlineReputation?.required===false?'n/a':d.campaign.evidence?.airlineReputation?.verifiedActive===true?'✅':d.campaign.evidence?.airlineReputation?'❌':'n/d';
    const gate=d.campaign.departureAuthorized===true?'✅':d.campaign.departureAuthorized===false?'⛔':'n/d';
    lines.push('Campanhas: Eco '+eco+' | Reputation '+rep+' | decolagens '+gate);
  }
  if(d?.quarantines)lines.push('Segurança: quarentenas D'+n(d.quarantines.departure)+' R'+n(d.quarantines.route)+' P'+n(d.quarantines.pricingRoute)+' S'+n(d.quarantines.supplyKinds)+' | UI '+(d.uiHealth?.status||'n/d'));
  if(process.env.RUN_URL)lines.push('Run: '+process.env.RUN_URL);
  return lines.join('\n').slice(0,3500);
}

async function main() {
  if (process.env.DEMAND_TELEGRAM_ENABLED !== 'true') return;
  const token = process.env.TELEGRAM_BOT_TOKEN, chatId = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chatId) { console.log('[Demand] Telegram nao configurado.'); return; }
  const summary = runSummaryMessage('test-results/demand',process.env.BOT_RESULT);
  const alert = importantMessage('test-results/demand',process.env.BOT_RESULT);
  const text = alert ? summary+'\n'+alert : summary;
  const payload={chat_id:chatId,text};
  if(process.env.AUTOMATION_MODE==='semi-automatic'&&/^https:\/\/github\.com\//.test(process.env.WORKFLOW_URL||'')){
    payload.reply_markup={inline_keyboard:[[{text:'Abrir GitHub Actions',url:process.env.WORKFLOW_URL}]]};
  }
  const body = JSON.stringify(payload);
  await new Promise((resolve, reject) => {
    const req = https.request({ hostname: 'api.telegram.org', path: '/bot'+token+'/sendMessage', method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }, timeout: 15000 }, res => {
      let raw = '';
      res.setEncoding('utf8');
      res.on('data', chunk => { if (raw.length < 4096) raw += chunk; });
      res.on('end', () => {
        if (res.statusCode === 200) return resolve();
        let description = '';
        try {
          const parsed = JSON.parse(raw);
          if (typeof parsed.description === 'string') description = parsed.description.replace(/[\r\n\t]+/g, ' ').slice(0, 180);
        } catch {}
        reject(new Error('Telegram API '+(res.statusCode || 'erro')+(description ? ': '+description : '')));
      });
    });
    req.on('timeout', () => req.destroy(new Error('Telegram timeout')));
    req.on('error', error => reject(new Error(error?.message === 'Telegram timeout' ? 'Telegram timeout' : 'Telegram network error')));
    req.end(body);
  });
}

if (require.main === module) main().catch(error => {
  console.error('[Demand] '+String(error?.message || 'Telegram notification failed'));
  console.log('::warning::Falha ao enviar notificacao Telegram; consulte o log seguro desta etapa.');
  process.exitCode = 1;
});

module.exports = { message, importantMessage, runSummaryMessage, fuelWindowMessage };
