import { mkdir,writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { AircraftSnapshot, CollectionResult } from '../demand/types';
import type { MarketPriceReference } from './cost-reference-reader';
import { relativeAgeIntervalMinutes } from './demand-reset-ledger';

type ReviewResearchEntry={
  aircraftId:string;status:string;
  result:null|{quotes:readonly unknown[];screenedOut:readonly unknown[]};
};
type ReviewCandidate={
  aircraftId:string;from:string;to:string;
  variableCycleComparison:{status:string;comparisonReady:boolean};
  candidateVariableCycle:{status:string;recurringCycleProfitPerHour:{low:number|null;expected:number|null;high:number|null}};
};
type ReviewDecision={
  aircraftId:string;decision:'would_reroute'|'keep_route'|'hold'|'unavailable';
  compared:number;dominating:number;candidateSetComplete:boolean;reason:string;
  selected:null|{from:string;to:string;airportId:string;conservativeProfitPerHour:number;firstCycleLow:number};
};
export interface AircraftRouteReviewInput {
  collection:CollectionResult;
  research:{aircraft:readonly ReviewResearchEntry[]};
  analysis:{
    candidates:readonly ReviewCandidate[];
    routeDecisions:readonly ReviewDecision[];
    market:{fuel:MarketPriceReference|null;co2:MarketPriceReference|null};
  };
}
export interface AircraftRouteReviewRow {
  aircraftId:string;registration:string;
  currentRoute:{from:string;to:string;routeId:string;state:string};
  currentObserved:{
    scope:'observed-flights-of-current-airport-pair-only';
    sampleCount:number;
    grossRevenuePerFlight:number|null;
    fuelLbsPerFlight:number|null;
    co2QuotasPerFlight:number|null;
    fuelReplacementCostPerFlight:number|null;
    co2ReplacementCostPerFlight:number|null;
    grossLessFuelCo2ReplacementPerFlight:number|null;
    profitNotProven:true;
  };
  calculator:{source:'native-game-quotes-and-curated-static-screen';researchStatus:string;quotes:number;compared:number};
  verdict:'switch_proposed'|'keep_among_verified_comparisons'|'awaiting_economic_evidence'|'pending_research';
  proposedRoute:null|{from:string;to:string;airportId:string;conservativeProfitPerHour:number;firstCycleLow:number};
  globallyBestProven:false;
  comparisonSetComplete:boolean;
  reason:string;
  mutationAuthorized:false;
}
export interface AircraftRouteReviewReport{
  schemaVersion:1;generatedAt:string;fleetComplete:boolean;
  summary:{aircraft:number;switchProposed:number;keepVerified:number;awaitingEvidence:number;pendingResearch:number};
  aircraft:AircraftRouteReviewRow[];
  /** Inspecting the game is not authorization to change it. */
  comparisonReady:false;mutationAuthorized:false;
}
const finite=(v:unknown):v is number=>typeof v==='number'&&Number.isFinite(v)&&Math.abs(v)<=Number.MAX_SAFE_INTEGER;
const price=(p:MarketPriceReference|null,kind:'fuel'|'co2',now:Date,maxAge:number)=>{
  if(!p||p.commodity!==kind||p.unit!==(kind==='fuel'?'lbs':'quotas')||
    p.source!=='inspected-market'||!finite(p.pricePer1000)||p.pricePer1000<=0)return null;
  const age=now.getTime()-Date.parse(p.observedAt);
  return Number.isFinite(age)&&age>=0&&age<=maxAge*1000?p.pricePer1000:null;
};
const avg=(n:number[],length:number)=>n.reduce((sum,val)=>sum+val,0)/length;
export function observeCurrentRouteHistory(
  a:AircraftSnapshot,market:AircraftRouteReviewInput['analysis']['market'],now=new Date(),maxAgeSeconds=300
):AircraftRouteReviewRow['currentObserved']{
  const base:AircraftRouteReviewRow['currentObserved']={
    scope:'observed-flights-of-current-airport-pair-only',sampleCount:0,
    grossRevenuePerFlight:null,fuelLbsPerFlight:null,co2QuotasPerFlight:null,
    fuelReplacementCostPerFlight:null,co2ReplacementCostPerFlight:null,
    grossLessFuelCo2ReplacementPerFlight:null,profitNotProven:true
  };
  if(!Number.isSafeInteger(maxAgeSeconds)||maxAgeSeconds<1||!Number.isFinite(now.getTime())||
    !a.from||!a.to||a.from===a.to||a.issue||
    a.flightHistory?.status!=='observed'||!a.flightHistory.entries.length)return base;
  const snapshotAge=now.getTime()-Date.parse(a.observedAt);
  const historyAge=now.getTime()-Date.parse(a.flightHistory.observedAt);
  if(!Number.isFinite(snapshotAge)||snapshotAge<0||snapshotAge>maxAgeSeconds*1000||
    !Number.isFinite(historyAge)||historyAge<0||historyAge>maxAgeSeconds*1000)return base;
  const rows=a.flightHistory.entries.filter(h=>{
    const age=relativeAgeIntervalMinutes(h.relativeTime);
    return age!==null&&age.lower>=0&&age.upper<=1440&&
      ((h.from===a.from&&h.to===a.to)||(h.from===a.to&&h.to===a.from))&&
      [h.revenue,h.fuelLbs,h.co2Quotas,h.onboard.Y,h.onboard.J,h.onboard.F]
        .every(x=>Number.isSafeInteger(x)&&x>=0);
  });
  if(!rows.length)return base;
  const gross=avg(rows.map(r=>r.revenue),rows.length);
  const fuel=avg(rows.map(r=>r.fuelLbs),rows.length);
  const co2=avg(rows.map(r=>r.co2Quotas),rows.length);
  const fuelPrice=price(market.fuel,'fuel',now,maxAgeSeconds);
  const co2Price=price(market.co2,'co2',now,maxAgeSeconds);
  const fuelCost=fuelPrice!==null?fuel*fuelPrice/1000:null;
  const co2Cost=co2Price!==null?co2*co2Price/1000:null;
  return {...base,sampleCount:rows.length,
    grossRevenuePerFlight:gross,fuelLbsPerFlight:fuel,co2QuotasPerFlight:co2,
    fuelReplacementCostPerFlight:fuelCost,co2ReplacementCostPerFlight:co2Cost,
    grossLessFuelCo2ReplacementPerFlight:fuelCost!==null&&co2Cost!==null?gross-fuelCost-co2Cost:null};
}
/**
 * Review the CURRENT route first, then show what native quote research and the
 * economic calculator actually verified. Current historical contribution is
 * diagnostic ONLY: does not include A-check, repair, tax, setup or market drift.
 */
export function buildAircraftRouteReview(
  input:AircraftRouteReviewInput,now=new Date(),maxAgeSeconds=300
):AircraftRouteReviewReport{
  const rows=input.collection.aircraft.map(a=>{
    const research=input.research.aircraft.find(r=>r.aircraftId===a.aircraftId);
    const decision=input.analysis.routeDecisions.find(d=>d.aircraftId===a.aircraftId);
    const related=input.analysis.candidates.filter(c=>c.aircraftId===a.aircraftId);
    const selected=decision?.decision==='would_reroute'&&decision.selected&&
      related.some(c=>c.from===decision.selected!.from&&c.to===decision.selected!.to&&
        c.variableCycleComparison.status==='candidate_dominates'&&c.variableCycleComparison.comparisonReady&&
        c.candidateVariableCycle.status==='verified_interval'&&
        finite(c.candidateVariableCycle.recurringCycleProfitPerHour.low))?decision.selected:null;
    const verdict:AircraftRouteReviewRow['verdict']=selected?'switch_proposed':
      decision?.decision==='keep_route'&&decision.candidateSetComplete?'keep_among_verified_comparisons':
      research?.result?.quotes.length||related.length?'awaiting_economic_evidence':'pending_research';
    return {
      aircraftId:a.aircraftId,registration:a.registration,
      currentRoute:{from:a.from,to:a.to,routeId:a.routeId,state:a.state},
      currentObserved:observeCurrentRouteHistory(a,input.analysis.market,now,maxAgeSeconds),
      calculator:{source:'native-game-quotes-and-curated-static-screen' as const,
        researchStatus:research?.status||'not_inspected',
        quotes:research?.result?.quotes.length||0,compared:decision?.compared||0},
      verdict,proposedRoute:selected?{...selected}:null,globallyBestProven:false as const,
      comparisonSetComplete:decision?.candidateSetComplete===true,
      reason:decision?.reason||'NO_VERIFIED_CANDIDATE_COMPARISON',
      mutationAuthorized:false as const
    };
  });
  return {schemaVersion:1,generatedAt:now.toISOString(),fleetComplete:input.collection.complete,
    summary:{aircraft:rows.length,
      switchProposed:rows.filter(x=>x.verdict==='switch_proposed').length,
      keepVerified:rows.filter(x=>x.verdict==='keep_among_verified_comparisons').length,
      awaitingEvidence:rows.filter(x=>x.verdict==='awaiting_economic_evidence').length,
      pendingResearch:rows.filter(x=>x.verdict==='pending_research').length},
    aircraft:rows,comparisonReady:false,mutationAuthorized:false};
}
export async function writeAircraftRouteReview(report:AircraftRouteReviewReport,directory='test-results/demand'){
  await mkdir(directory,{recursive:true});
  await writeFile(join(directory,'aircraft-route-review.json'),JSON.stringify(report,null,2)+'\n');
  const safe=(s:string)=>s.replace(/[|\r\n<>]/g,' ').slice(0,140);
  const num=(n:number|null)=>n===null?'n/d':n.toFixed(2);
  await writeFile(join(directory,'aircraft-route-review.md'),[
    '# Revisao de rotas — uma aeronave por vez','',
    'Rota atual → calculadora de cotacoes do jogo e referencias curadas → comparacao economica → manter, trocar ou reavaliar.','',
    'Lucro real nao comprovado pelo historico parcial: o saldo de receita menos combustivel e CO2 a preco de reposicao NAO inclui manutencao, taxas e outros custos.','',
    '| Aeronave | Rota atual | Voos historicos | Receita/voo | Receita menos Fuel e CO2/voo (parcial) | Cotacoes | Comparadas | Resultado | Rota proposta |',
    '| --- | --- | ---: | ---: | ---: | ---: | ---: | --- | --- |',
    ...report.aircraft.map(a=>[
      safe(a.registration),safe(a.currentRoute.from)+'–'+safe(a.currentRoute.to),a.currentObserved.sampleCount,
      num(a.currentObserved.grossRevenuePerFlight),num(a.currentObserved.grossLessFuelCo2ReplacementPerFlight),
      a.calculator.quotes,a.calculator.compared,a.verdict,
      a.proposedRoute?safe(a.proposedRoute.from)+'–'+safe(a.proposedRoute.to):'-'
    ].join(' | ').replace(/^/,'| ').concat(' |')),
    '', 'O ranking curado nao prova melhor rota global. Apenas uma comparacao economica completa e controle nativo validado pode levar a troca via executor separado.',
    'O bot externo do Discord nao foi consultado por este relatorio; o calculo e feito com as cotacoes nativas e referencia curada disponivel no repositorio.',
    'Nenhuma linha deste relatorio autoriza mutacao.',''
  ].join('\n'));
}
