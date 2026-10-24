import type { AircraftSnapshot } from '../demand/types';
import type { CandidateQuote } from './quote-reader';
import type { RouteCatalog } from './reference-data';
import { relativeAgeIntervalMinutes } from './demand-reset-ledger';

export interface Co2CalibrationSample {
  from:string;
  to:string;
  distanceKm:number;
  quotas:number;
  onboard:{Y:number;J:number;F:number};
  weightedCabinUnits:number;
  physicalPassengers:number;
  weightedResidualPerKm:number;
  physicalResidualPerKm:number;
}
export interface Co2CalibrationEvidence {
  aircraftId:string;
  status:'verified_weighted_cabin_units'|'verified_single_cabin_equivalence'|'insufficient'|'inconsistent';
  observedAt:string;
  quoteFactor:number|null;
  calibratedFactorPerUnit:number|null;
  fixedQuotasPerKm:number|null;
  samples:Co2CalibrationSample[];
  weightedResidualSpread:number|null;
  physicalResidualSpread:number|null;
  weightedMeanAbsoluteErrorRatio:number|null;
  physicalMeanAbsoluteErrorRatio:number|null;
  formulaVerified:boolean;
  /** Diagnostic: only the most recent chronological eight rows can replace a drifted lifetime fit. */
  fitScope?:'full_history'|'recent_consecutive_eight'|'unavailable';
  fitSamplesUsed?:number;
  reason:string;
  comparisonReady:false;
  mutationAuthorized:false;
}

const fresh=(stamp:string,now:Date,maxAgeSeconds:number)=>{
  const age=now.getTime()-Date.parse(stamp);
  return Number.isFinite(age)&&age>=0&&age<=maxAgeSeconds*1000;
};
const pair=(a:string,b:string,x:string,y:string)=>(a===x&&b===y)||(a===y&&b===x);
const spread=(values:number[])=>values.length?Math.max(...values)-Math.min(...values):null;
const mean=(values:number[])=>values.reduce((a,b)=>a+b,0)/values.length;
const round=(value:number)=>Math.round(value*1e9)/1e9;
const fit=(samples:Co2CalibrationSample[],units:(s:Co2CalibrationSample)=>number)=>{
  const xs=samples.map(units),ys=samples.map(s=>s.quotas/s.distanceKm),xm=mean(xs),ym=mean(ys);
  const denominator=xs.reduce((sum,x)=>sum+(x-xm)**2,0);
  if(!Number.isFinite(denominator)||denominator<=0)return null;
  const slope=xs.reduce((sum,x,i)=>sum+(x-xm)*(ys[i]-ym),0)/denominator,intercept=ym-slope*xm;
  if(!Number.isFinite(slope)||!Number.isFinite(intercept))return null;
  const residuals=samples.map((s,i)=>ys[i]-(intercept+slope*xs[i]));
  const errors=samples.map((s,i)=>Math.abs(s.distanceKm*(intercept+slope*xs[i])-s.quotas)/Math.max(1,s.quotas));
  return {slope,intercept,residualSpread:spread(residuals)!,mae:mean(errors)};
};

/**
 * Calibrates only a formula shape already evidenced by the game's own visible
 * flight history. It does not assume that "kg" and quota are interchangeable:
 * it checks whether the live quote factor plus Y+2J+3F and a stable per-km
 * intercept reproduce observed quota usage across multiple historical flights.
 */
export function calibrateCo2FromFlightHistory(
  aircraft:AircraftSnapshot,
  quotes:CandidateQuote[],
  catalog:RouteCatalog|null,
  now=new Date(),
  maxAgeSeconds=300
):Co2CalibrationEvidence {
  const base:Co2CalibrationEvidence={
    aircraftId:aircraft.aircraftId,status:'insufficient',observedAt:now.toISOString(),
    quoteFactor:null,calibratedFactorPerUnit:null,fixedQuotasPerKm:null,samples:[],
    weightedResidualSpread:null,physicalResidualSpread:null,
    weightedMeanAbsoluteErrorRatio:null,physicalMeanAbsoluteErrorRatio:null,
    formulaVerified:false,fitScope:'unavailable',fitSamplesUsed:0,
    reason:'EVIDENCE_INCOMPLETE',comparisonReady:false,mutationAuthorized:false
  };
  if(!Number.isSafeInteger(maxAgeSeconds)||maxAgeSeconds<1||!catalog||catalog.schemaVersion!==1||
    !Array.isArray(catalog.routes)||aircraft.issue||!aircraft.capacity||!aircraft.flightHistory||
    aircraft.flightHistory.status!=='observed'||!fresh(aircraft.observedAt,now,maxAgeSeconds)||
    !fresh(aircraft.flightHistory.observedAt,now,maxAgeSeconds)||!aircraft.flightHistory.entries.length)
    return base;

  const live=quotes.filter(q=>q.aircraftId===aircraft.aircraftId&&q.registration===aircraft.registration&&
    fresh(q.observedAt,now,maxAgeSeconds)&&Number.isFinite(q.co2KgPerPaxKm)&&q.co2KgPerPaxKm>0);
  // One live, identity/direction-verified quote is enough to propose the factor
  // because the historical fit below independently corroborates or rejects it.
  // Additional live quotes, when present, must all agree exactly.
  if(live.length<1)return {...base,reason:'LIVE_QUOTE_CO2_FACTOR_MISSING'};
  const factors=[...new Set(live.map(q=>q.co2KgPerPaxKm))];
  if(factors.length!==1)return {...base,status:'inconsistent',reason:'LIVE_QUOTE_CO2_FACTOR_CONFLICT'};
  const factor=factors[0];

  const samples:Co2CalibrationSample[]=[];
  for(const h of aircraft.flightHistory.entries){
    if(!/^[A-Z0-9]{3}$/.test(h.from)||!/^[A-Z0-9]{3}$/.test(h.to)||h.from===h.to)continue;
    const refs=catalog.routes.filter(r=>!r.conflict&&pair(r.from,r.to,h.from,h.to)&&
      Number.isFinite(r.distanceKm)&&r.distanceKm>0);
    const distances=[...new Set(refs.map(r=>r.distanceKm))];
    if(!refs.length||distances.length!==1)continue;
    const distanceKm=distances[0];
    const {Y,J,F}=h.onboard;
    if(![Y,J,F,h.co2Quotas].every(Number.isSafeInteger)||[Y,J,F,h.co2Quotas].some(n=>n<0))continue;
    if(Y>aircraft.capacity.Y||J>aircraft.capacity.J||F>aircraft.capacity.F)continue;
    const weightedCabinUnits=Y+2*J+3*F;
    const physicalPassengers=Y+J+F;
    const observedPerKm=h.co2Quotas/distanceKm;
    const weightedResidualPerKm=observedPerKm-factor*weightedCabinUnits;
    const physicalResidualPerKm=observedPerKm-factor*physicalPassengers;
    if(![observedPerKm,weightedResidualPerKm,physicalResidualPerKm].every(Number.isFinite))continue;
    samples.push({
      from:h.from,to:h.to,distanceKm,quotas:h.co2Quotas,onboard:{Y,J,F},
      weightedCabinUnits,physicalPassengers,
      weightedResidualPerKm:round(weightedResidualPerKm),
      physicalResidualPerKm:round(physicalResidualPerKm)
    });
  }
  if(samples.length<4)return {...base,quoteFactor:factor,samples,reason:'TOO_FEW_RESOLVED_HISTORY_SAMPLES'};

  const assess=(rows:Co2CalibrationSample[])=>{
    const weightedFit=fit(rows,s=>s.weightedCabinUnits);
    const physicalFit=fit(rows,s=>s.physicalPassengers);
    if(!weightedFit||!physicalFit)return null;
    const fixed=weightedFit.intercept,weightedSpread=weightedFit.residualSpread;
    const weightedMae=weightedFit.mae,physicalSpread=physicalFit.residualSpread,physicalMae=physicalFit.mae;
    // The current UI rounds the factor to two decimals. Never silently
    // accept historical slopes outside that displayed interval.
    const factorCompatible=Math.abs(weightedFit.slope-factor)<0.005;
    const premiumMix=new Set(rows.map(r=>r.onboard.J+2*r.onboard.F)).size>=2&&
      rows.some(r=>r.onboard.J+r.onboard.F>0);
    const loadMix=new Set(rows.map(r=>r.weightedCabinUnits)).size>=3;
    const stable=factorCompatible&&weightedFit.slope>0&&Number.isFinite(fixed)&&
      fixed>=0&&weightedSpread<=0.025&&weightedMae<=0.005;
    const distinguishes=premiumMix&&loadMix&&
      (physicalSpread>=weightedSpread+0.05||physicalMae>=Math.max(0.002,weightedMae*2));
    const economyOnly=aircraft.capacity!.Y>0&&aircraft.capacity!.J===0&&aircraft.capacity!.F===0&&
      rows.every(r=>r.onboard.J===0&&r.onboard.F===0);
    const singleCabinEquivalent=economyOnly&&loadMix;
    return {weightedFit,physicalFit,fixed,weightedSpread,weightedMae,physicalSpread,physicalMae,
      factorCompatible,stable,singleCabinEquivalent,
      verified:stable&&(distinguishes||singleCabinEquivalent)};
  };
  let selected=assess(samples);
  if(!selected)return {...base,quoteFactor:factor,samples,reason:'HISTORY_LOAD_VARIATION_INSUFFICIENT'};
  let fitScope:'full_history'|'recent_consecutive_eight'='full_history';
  let fitSamplesUsed=samples.length;

  // Older training, fleet configuration, or route-model changes can make a
  // lifetime fit nonstationary. Recalibrate ONLY from the eight *first*
  // consecutive chronological rows, not an opportunistically chosen subset,
  // and only when the new interval independently agrees with the LIVE factor.
  // Any gap, ambiguous relative age, or instability keeps the original HOLD.
  const newest=aircraft.flightHistory.entries.slice(0,8);
  const ages=newest.map(r=>relativeAgeIntervalMinutes(r.relativeTime));
  const contiguous=newest.length===8&&samples.length>=8&&newest.every((h,i)=>{
    const r=samples[i];
    return r.from===h.from&&r.to===h.to&&r.quotas===h.co2Quotas&&
      r.onboard.Y===h.onboard.Y&&r.onboard.J===h.onboard.J&&r.onboard.F===h.onboard.F;
  });
  const ageOrdered=ages.length===8&&ages.every((a,i)=>
    a!==null&&a.lower>=0&&(i===0||ages[i-1]!==null&&a.lower>=ages[i-1]!.lower));
  const recentlyObserved=ageOrdered&&ages[0]!.lower<=360&&ages[7]!.upper<=1440;
  if(!selected.verified&&contiguous&&recentlyObserved){
    const recent=assess(samples.slice(0,8));
    if(recent?.verified){
      selected=recent;
      fitScope='recent_consecutive_eight';
      fitSamplesUsed=8;
    }
  }

  const verified=selected.verified;
  const singleCabinEquivalent=selected.singleCabinEquivalent;
  return {
    ...base,
    status:verified?(singleCabinEquivalent?'verified_single_cabin_equivalence':'verified_weighted_cabin_units'):
      selected.stable?'insufficient':'inconsistent',
    quoteFactor:factor,calibratedFactorPerUnit:round(selected.weightedFit.slope),
    fixedQuotasPerKm:round(selected.fixed),samples,
    weightedResidualSpread:round(selected.weightedSpread),
    physicalResidualSpread:round(selected.physicalSpread),
    weightedMeanAbsoluteErrorRatio:round(selected.weightedMae),
    physicalMeanAbsoluteErrorRatio:round(selected.physicalMae),
    formulaVerified:verified,fitScope,fitSamplesUsed,
    reason:verified?(fitScope==='recent_consecutive_eight'?
      'EIGHT_NEWEST_CONSECUTIVE_FLIGHTS_AGREE_WITH_LIVE_QUOTE_FACTOR':
      singleCabinEquivalent?'LIVE_HISTORY_SUPPORTS_ECONOMY_ONLY_EQUIVALENT_FORMULA_WITH_STABLE_PER_KM_INTERCEPT':
      'LIVE_HISTORY_SUPPORTS_WEIGHTED_CABIN_UNITS_WITH_STABLE_PER_KM_INTERCEPT'):
      !selected.factorCompatible?'HISTORICAL_FACTOR_OUTSIDE_LIVE_DISPLAY_ROUNDING':
      !selected.stable?'WEIGHTED_FORMULA_NOT_STABLE':
      'PREMIUM_CABIN_MIX_INSUFFICIENT_TO_DISTINGUISH_FORMULA'
  };
}

export function estimateObservedCo2Quotas(
  evidence:Co2CalibrationEvidence,
  distanceKm:number,
  onboard:{Y:number;J:number;F:number}
):number|null {
  if(!evidence.formulaVerified||!['verified_weighted_cabin_units','verified_single_cabin_equivalence'].includes(evidence.status)||
    evidence.calibratedFactorPerUnit===null||evidence.fixedQuotasPerKm===null||
    !Number.isFinite(distanceKm)||distanceKm<=0||
    ![onboard.Y,onboard.J,onboard.F].every(Number.isSafeInteger)||[onboard.Y,onboard.J,onboard.F].some(n=>n<0))
    return null;
  const weighted=onboard.Y+2*onboard.J+3*onboard.F;
  const quotas=distanceKm*(evidence.fixedQuotasPerKm+evidence.calibratedFactorPerUnit*weighted);
  return Number.isFinite(quotas)&&quotas>=0?Math.round(quotas):null;
}
