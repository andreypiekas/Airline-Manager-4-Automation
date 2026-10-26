import { AircraftSnapshot, Cabins, CollectionResult, DemandConfig, DemandDecision } from './types';
import { DemandManager } from './manager';
import type { AdaptiveThreshold } from './adaptive-threshold';
import { estimatedGrossTicketRevenue } from './revenue';
import { MUTATION_COMPLETION_RESERVE_MS } from '../utils/run-time-budget';
import { orderVerifiedDepartureCandidates } from './rolling-first-page-priority';

export interface CurrentRouteFuelEvidence {
  aircraftId:string;routeId:string;from:string;to:string;fuelLbs:number;observedAt:string;
}
export interface DeparturePort {
  collect(): Promise<CollectionResult>;
  /** Optional bounded, read-only exact-current-route quote; no departure or reroute mutation. */
  readCurrentRouteFuelQuote?(expected:AircraftSnapshot):Promise<CurrentRouteFuelEvidence|null>;
  /** Fresh identity/layout/demand AND a strictly verified native departure control. */
  prepare(expected: AircraftSnapshot): Promise<AircraftSnapshot>;
  depart(expected: AircraftSnapshot): Promise<void>;
  confirm(expected: AircraftSnapshot): Promise<AircraftSnapshot | null>;
}
export interface ExecutionSettings {
  dryRun: boolean;
  maxDepartures: number | 'all';
  /** True only for fresh, target-by-target Fleet validation. No global-complete claim. */
  rollingIndividualMode?: boolean;
  /** Absolute deadline after which no new departure mutation may start. */
  mutationDeadlineEpochMs?: number;
  blockedDepartureKeys?: ReadonlySet<string>;
  /** Scheduling hint from durable journal; never a departure authorization. */
  prioritizedDepartureKeys?: ReadonlySet<string>;
  /** Scheduling hint from a freshly matched first native Fleet page; no departure permission. */
  firstPageReadyPriorityKeys?: ReadonlySet<string>;
  /** Verified fuel holding observed in this same run. Used only to block unsafe clicks. */
  fuelHoldingLbsAtRunStart?: number;
  /** False means required marketing campaigns were not freshly confirmed in this run. */
  campaignVerified?: boolean;
  /** Aircraft rerouted in this run remain held until pricing on the new route is freshly verified. */
  postReroutePricingBlockedAircraftIds?: ReadonlySet<string>;
  /** Fresh read-only current-route quote evidence collected earlier in this same run. */
  currentRouteFuelEvidence?: ReadonlyMap<string,CurrentRouteFuelEvidence>;
}
export interface ExecutionEntry {
  aircraftId: string; registration: string; routeId: string; from: string; to: string;
  status: 'held' | 'would_depart' | 'attempting' | 'departed' | 'outcome_unknown';
  reason: string; demand: DemandDecision | null; actualOnboard: AircraftSnapshot['onboard'];
  /** Verified onboard × freshly observed fares. Estimate only, not the Finance ledger. */
  estimatedGrossTicketRevenue?: number | null;
  /** Fixed, non-sensitive failure category for read-only departure preparation. Never a raw browser error. */
  prepareFailureCode?: string;
  resourceEvidence?: {
    fuelHoldingLbsAtRunStart:number;
    fuelCommittedBefore:number;
    fuelAvailableBefore:number;
    verifiedRouteFuelLbs:number|null;
    matchingHistorySamples:number;
    fuelEvidenceSource:'history'|'current-route-quote'|null;
    trackingComplete:boolean;
  };
}
export interface ExecutionReport {
  schemaVersion: 1; dryRun: boolean; scope: 'existing-route-ready-aircraft';
  generatedAt: string; completedAt: string | null; halted: boolean;
  summary: { evaluated: number; departed: number; simulated: number; held: number; unknown: number };
  entries: ExecutionEntry[];
}
const sameContext = (a: AircraftSnapshot,b: AircraftSnapshot) => a.aircraftId === b.aircraftId && a.routeId === b.routeId &&
  a.registration === b.registration && a.from === b.from && a.to === b.to && !!a.capacity && !!b.capacity &&
  (['Y','J','F'] as const).every(k=>a.capacity![k]===b.capacity![k]);

const routePairKey=(a:string,b:string)=>[a,b].sort().join(':');
const validDemandCabins=(c:Cabins|null|undefined):c is Cabins=>!!c&&(['Y','J','F'] as const).every(k=>Number.isSafeInteger(c[k])&&c[k]>=0);
const minCabins=(a:Cabins,b:Cabins):Cabins=>({Y:Math.min(a.Y,b.Y),J:Math.min(a.J,b.J),F:Math.min(a.F,b.F)});
const subtractCabins=(a:Cabins,b:Cabins):Cabins=>({Y:Math.max(0,a.Y-b.Y),J:Math.max(0,a.J-b.J),F:Math.max(0,a.F-b.F)});
const demandPoolKey=(a:AircraftSnapshot,scope:DemandConfig['poolScope'])=>scope==='airport-pair'?routePairKey(a.from,a.to):a.from+':'+a.to;
function verifiedHistoricalFuelRequirement(a:AircraftSnapshot):{fuelLbs:number;samples:number}|null{
  const history=a.flightHistory;
  if(!history||history.status!=='observed'||!Array.isArray(history.entries))return null;
  const pair=routePairKey(a.from,a.to);
  const matching=history.entries.filter(e=>routePairKey(e.from,e.to)===pair&&Number.isSafeInteger(e.fuelLbs)&&e.fuelLbs>0);
  // Fuel varies slightly between departures on the SAME aircraft/airport pair.
  // Requiring identical history values held every ready aircraft in run #862.
  // Reserve the highest actually observed consumption (never the average/minimum),
  // while retaining the two-observation gate and all fresh UI/departure checks.
  // This is a conservative historical stock budget, NOT a fabricated game quote.
  if(matching.length<2)return null;
  return {fuelLbs:Math.max(...matching.map(e=>e.fuelLbs)),samples:matching.length};
}
function verifiedCurrentRouteFuelRequirement(
  a:AircraftSnapshot,
  evidence:ExecutionSettings['currentRouteFuelEvidence'],
  maxAgeSeconds:number,
  now=Date.now()
):{fuelLbs:number;samples:0}|null{
  const e=evidence?.get(a.aircraftId);
  if(!e||e.aircraftId!==a.aircraftId||e.routeId!==a.routeId||e.from!==a.from||e.to!==a.to||
    !Number.isSafeInteger(e.fuelLbs)||e.fuelLbs<=0)return null;
  const age=now-Date.parse(e.observedAt);
  if(!Number.isFinite(age)||age<0||age>maxAgeSeconds*1000)return null;
  return {fuelLbs:e.fuelLbs,samples:0};
}

const SAFE_PREPARE_FAILURE_CODES=new Set([
  'DEPARTURE_FLEET_COUNT_CHANGED','DEPARTURE_HANDLER_UNVERIFIED',
  'RESEARCH_LIST_CONTROL_UNVERIFIED','RESEARCH_QUOTE_NOT_CLOSED',
  'RESEARCH_ROUTE_COUNT_UNAVAILABLE','RESEARCH_PAGINATION_INVALID',
  'RESEARCH_ROUTE_NOT_FOUND','RESEARCH_PAGINATION_CONTROL_UNVERIFIED',
  'RESEARCH_PAGINATION_LIMIT','RESEARCH_ROUTE_NOT_AVAILABLE',
  'RESEARCH_IDENTITY_INVALID','RESEARCH_STATE_UNAVAILABLE',
  'RESEARCH_CONTEXT_CHANGED','RESEARCH_NOT_READY','DETAILS_CARD_NOT_VISIBLE',
  'INTERACTIVE_CHALLENGE_DETECTED_STOP'
]);
/** Persist only fixed diagnostic codes. Playwright errors may contain DOM, URLs or private data. */
function safePrepareFailureCode(error:unknown):string {
  const message=error instanceof Error?error.message:'';
  if(SAFE_PREPARE_FAILURE_CODES.has(message))return message;
  if(/timeout/i.test(message))return 'PLAYWRIGHT_TIMEOUT';
  return 'UNCLASSIFIED';
}

/** No retries, bulk fallback, route mutations or financial modules. A report writer must persist BEFORE the click. */
export class IndividualDepartureExecutor {
  private used = false;
  private readonly attemptedAircraft = new Set<string>();
  private readonly attemptedRoutes = new Set<string>();
  constructor(private readonly port: DeparturePort,private readonly demand: DemandConfig,
    private readonly settings: ExecutionSettings,private readonly save: (report: ExecutionReport)=>Promise<void>,
    private readonly adaptive:ReadonlyMap<string,AdaptiveThreshold>=new Map()) {
    if (!demand.enabled || !demand.failSafe || (settings.maxDepartures!=='all' && (!Number.isSafeInteger(settings.maxDepartures) || settings.maxDepartures<1 || settings.maxDepartures>100)))
      throw new Error('EXECUTION_SETTINGS_INVALID');
  }
  async run(): Promise<ExecutionReport> {
    if(this.used)throw new Error('EXECUTION_ALREADY_USED');
    this.used=true;
    const report: ExecutionReport={schemaVersion:1,dryRun:this.settings.dryRun,scope:'existing-route-ready-aircraft',
      generatedAt:new Date().toISOString(),completedAt:null,halted:false,summary:{evaluated:0,departed:0,simulated:0,held:0,unknown:0},entries:[]};
    const persist=async()=>{
      report.summary={evaluated:report.entries.length,departed:report.entries.filter(e=>e.status==='departed').length,
        simulated:report.entries.filter(e=>e.status==='would_depart').length,held:report.entries.filter(e=>e.status==='held').length,
        unknown:report.entries.filter(e=>e.status==='outcome_unknown').length};
      await this.save(report);
    };
    await persist();
    // Earlier planning quotes are only hints. Re-read a cold route immediately
    // before its individual departure if history is insufficient and the quote
    // is missing or stale. Never increase the accepted age or infer fuel.
    const fuelQuoteEvidence=new Map(this.settings.currentRouteFuelEvidence||[]);
    let fuelCommitted=0;
    let fuelTrackingComplete=this.settings.fuelHoldingLbsAtRunStart===undefined?false:
      Number.isSafeInteger(this.settings.fuelHoldingLbsAtRunStart)&&this.settings.fuelHoldingLbsAtRunStart>=0;
    if(this.settings.fuelHoldingLbsAtRunStart!==undefined&&!fuelTrackingComplete)throw new Error('EXECUTION_FUEL_BUDGET_INVALID');
    let initial: CollectionResult;
    try { initial=await this.port.collect(); } catch { report.halted=true;await persist();throw new Error('EXECUTION_INITIAL_COLLECTION_FAILED'); }
    const rollingWindowVerified=this.settings.rollingIndividualMode===true &&
      initial.complete===false && initial.observationScope==='native-individual-first-page' &&
      initial.expectedRoutes!==null && Number.isSafeInteger(initial.expectedRoutes) &&
      initial.expectedRoutes>=initial.aircraft.length &&
      initial.windowReadyCandidates===initial.aircraft.length &&
      initial.aircraft.length<=8 &&
      initial.aircraft.every(a=>a.state==='ready'&&!a.issue&&
        /^[1-9]\\d*$/.test(a.aircraftId)&&/^[1-9]\\d*$/.test(a.routeId)&&
        !!a.registration.trim() && !!a.capacity && !!a.remaining && !!a.dailyTotal &&
        validDemandCabins(a.capacity)&&validDemandCabins(a.remaining)&&
        validDemandCabins(a.dailyTotal)&&
        ['Y','J','F'].every(k=>a.remaining![k as keyof Cabins]<=a.dailyTotal![k as keyof Cabins]));
    if(this.settings.rollingIndividualMode){
      console.log('[RollingDispatchCoverage] '+JSON.stringify({
        scope:'FIRST_NATIVE_PAGE_ONLY',globalComplete:false,
        individualVerified:rollingWindowVerified,
        targets:initial.aircraft.length,
        remainingUnassessed:initial.expectedRoutes===null?null:
          Math.max(0,initial.expectedRoutes-initial.aircraft.length)
      }));
    }
    const aircraftCounts=new Map<string,number>(),routeCounts=new Map<string,number>();
    const poolRemaining=new Map<string,Cabins>(),poolTotals=new Map<string,Cabins>(),inconsistentPools=new Set<string>();
    for(const a of initial.aircraft){
      aircraftCounts.set(a.aircraftId,(aircraftCounts.get(a.aircraftId)||0)+1);
      routeCounts.set(a.routeId,(routeCounts.get(a.routeId)||0)+1);
      if(a.state!=='ready'||!validDemandCabins(a.remaining)||!validDemandCabins(a.dailyTotal))continue;
      const key=demandPoolKey(a,this.demand.poolScope),current=poolRemaining.get(key),total=poolTotals.get(key);
      if(total&&(['Y','J','F'] as const).some(k=>total[k]!==a.dailyTotal![k]))inconsistentPools.add(key);
      poolTotals.set(key,{...a.dailyTotal});
      poolRemaining.set(key,current?minCabins(current,a.remaining):{...a.remaining});
    }

    // A prior run may have stopped before evaluating these aircraft. Put them
    // first *only after* this run has collected and checked a fresh fleet
    // inventory. Exact aircraft/route IDs are required and every safety gate
    // below still runs against freshly observed game state.
    const waiting=this.settings.prioritizedDepartureKeys??new Set<string>();
    const firstPageReady=this.settings.firstPageReadyPriorityKeys??new Set<string>();
    const ordered=orderVerifiedDepartureCandidates(initial,waiting,firstPageReady);
    // One complete fleet snapshot establishes global identity/pool integrity. Each
    // target is then re-read individually immediately before a possible mutation.
    for(const expected of ordered) {
      const entry: ExecutionEntry={aircraftId:expected.aircraftId,registration:expected.registration,routeId:expected.routeId,
        from:expected.from,to:expected.to,status:'held',reason:'DATA_UNAVAILABLE',demand:null,actualOnboard:null};
      report.entries.push(entry);
      if(report.halted){entry.reason='PREVIOUS_OUTCOME_UNKNOWN';continue;}
      if(this.settings.campaignVerified===false){entry.reason='CAMPAIGN_NOT_VERIFIED';continue;}
      if(this.settings.postReroutePricingBlockedAircraftIds?.has(expected.aircraftId)){
        entry.reason='REROUTE_PRICING_NOT_VERIFIED';continue;
      }
      if(this.attemptedAircraft.has(expected.aircraftId)||this.attemptedRoutes.has(expected.routeId)){entry.reason='ALREADY_ATTEMPTED';continue;}
      if(this.settings.blockedDepartureKeys?.has(expected.aircraftId+':'+expected.routeId)){entry.reason='PERSISTED_UNCERTAIN_DEPARTURE_BLOCK';continue;}
      if(this.settings.maxDepartures!=='all' && this.attemptedAircraft.size>=this.settings.maxDepartures){entry.reason='EXECUTION_LIMIT';continue;}
      if(!initial.complete&&!rollingWindowVerified){entry.reason='INITIAL_COLLECTION_INCOMPLETE';continue;}
      if((aircraftCounts.get(expected.aircraftId)||0)!==1||(routeCounts.get(expected.routeId)||0)!==1){
        entry.reason='INITIAL_IDENTITY_OR_ROUTE_DUPLICATE';continue;
      }
      if(!this.settings.dryRun&&this.settings.mutationDeadlineEpochMs!==undefined&&
        Date.now()>this.settings.mutationDeadlineEpochMs-MUTATION_COMPLETION_RESERVE_MS){
        entry.reason='RUN_TIME_BUDGET_EXHAUSTED_BEFORE_EVALUATION';continue;
      }
      // Departure on an already assigned AM4 route is intentionally base-agnostic.
      // Hub/base resolution is required for route review/reroute, not for dispatch.
      // Any ready aircraft may proceed from any airport when the existing route,
      // native Depart control, fresh demand and all safety/resource gates are verified.
      // Rolling execution cannot rely on an unknown supply stock.
      if(this.settings.rollingIndividualMode&&
        this.settings.fuelHoldingLbsAtRunStart===undefined){
        entry.reason='FUEL_HOLDING_UNVERIFIED_IN_ROLLING_MODE';continue;
      }
      if(!this.settings.dryRun&&this.settings.fuelHoldingLbsAtRunStart!==undefined&&
        !verifiedHistoricalFuelRequirement(expected)&&
        !verifiedCurrentRouteFuelRequirement(expected,fuelQuoteEvidence,this.demand.maxAgeSeconds)&&
        this.port.readCurrentRouteFuelQuote&&
        (this.settings.mutationDeadlineEpochMs===undefined||
         Date.now()<this.settings.mutationDeadlineEpochMs-MUTATION_COMPLETION_RESERVE_MS-30_000)){
        try{
          const evidence=await this.port.readCurrentRouteFuelQuote(expected);
          const verified=evidence&&evidence.aircraftId===expected.aircraftId&&
            evidence.routeId===expected.routeId&&evidence.from===expected.from&&evidence.to===expected.to&&
            Number.isSafeInteger(evidence.fuelLbs)&&evidence.fuelLbs>0&&
            verifiedCurrentRouteFuelRequirement(expected,new Map([[expected.aircraftId,evidence]]),this.demand.maxAgeSeconds);
          if(verified){
            fuelQuoteEvidence.set(expected.aircraftId,evidence!);
            console.log('[DepartureFuelQuote] '+JSON.stringify({status:'VERIFIED_CURRENT_ROUTE_FRESH',source:'native-read-only'}));
          }else console.warn('[DepartureFuelQuote] '+JSON.stringify({status:'UNAVAILABLE_REMAINS_HOLD'}));
        }catch(error){
          if(error instanceof Error&&
             (error.message.includes('INTERACTIVE_CHALLENGE_DETECTED_STOP')||
              error.message==='DEPARTURE_FUEL_QUOTE_UI_RESTORE_FAILED'))throw error;
          console.warn('[DepartureFuelQuote] '+JSON.stringify({status:'READ_FAILED_REMAINS_HOLD'}));
        }
      }
      let fresh: AircraftSnapshot;
      try {fresh=await this.port.prepare(expected);}catch(error){
        entry.reason='DEPARTURE_CONTROL_OR_FRESH_DETAILS_UNVERIFIED';
        entry.prepareFailureCode=safePrepareFailureCode(error);
        continue;
      }
      if(fresh.state!=='ready'||!sameContext(expected,fresh)){entry.reason='AIRCRAFT_CONTEXT_CHANGED';continue;}
      const key=demandPoolKey(fresh,this.demand.poolScope);
      if(inconsistentPools.has(key)){entry.reason='DEMAND_POOL_TOTALS_INCONSISTENT_AT_INITIAL_COLLECTION';continue;}
      const rawDemandValid=validDemandCabins(fresh.remaining)&&validDemandCabins(fresh.dailyTotal)&&
        (['Y','J','F'] as const).every(k=>fresh.remaining![k]<=fresh.dailyTotal![k]);
      if(rawDemandValid){
        const ceiling=poolRemaining.get(key);
        poolRemaining.set(key,ceiling?minCabins(ceiling,fresh.remaining!):{...fresh.remaining!});
      }
      const ceiling=poolRemaining.get(key);
      const boundedFresh=rawDemandValid&&ceiling?{...fresh,remaining:minCabins(fresh.remaining!,ceiling)}:fresh;
      // Analyze only the freshly re-read target. Global uniqueness/completeness came
      // from the initial full snapshot; the pool ceiling conservatively carries
      // shared-demand consumption across targets in this run.
      const decision=new DemandManager({...this.demand,dryRun:true},this.adaptive).analyze({
        aircraft:[boundedFresh],complete:true,expectedRoutes:1,warnings:[]
      }).decisions[0];
      entry.demand=decision;
      if(decision.decision!=='would_depart'){entry.reason=decision.reason;continue;}
      entry.reason=decision.reason;
      const historicalFuelEvidence=verifiedHistoricalFuelRequirement(fresh);
      const quoteFuelEvidence=verifiedCurrentRouteFuelRequirement(
        fresh,fuelQuoteEvidence,this.demand.maxAgeSeconds
      );
      // When both independent sources are present, debit the larger observed
      // requirement. Never let an earlier lower history mask a larger fresh quote.
      const fuelEvidence=historicalFuelEvidence&&quoteFuelEvidence
        ?(historicalFuelEvidence.fuelLbs>=quoteFuelEvidence.fuelLbs?historicalFuelEvidence:quoteFuelEvidence)
        :(historicalFuelEvidence||quoteFuelEvidence);
      const fuelEvidenceSource=fuelEvidence===historicalFuelEvidence&&fuelEvidence?'history':
        fuelEvidence===quoteFuelEvidence&&fuelEvidence?'current-route-quote':null;
      if(!this.settings.dryRun&&this.settings.fuelHoldingLbsAtRunStart!==undefined){
        const available=Math.max(0,this.settings.fuelHoldingLbsAtRunStart-fuelCommitted);
        entry.resourceEvidence={
          fuelHoldingLbsAtRunStart:this.settings.fuelHoldingLbsAtRunStart,
          fuelCommittedBefore:fuelCommitted,
          fuelAvailableBefore:available,
          verifiedRouteFuelLbs:fuelEvidence?.fuelLbs??null,
          matchingHistorySamples:historicalFuelEvidence?.samples??0,
          fuelEvidenceSource,
          trackingComplete:fuelTrackingComplete
        };
        if(!fuelTrackingComplete){entry.reason='FUEL_BUDGET_UNVERIFIED_AFTER_PRIOR_DEPARTURE';continue;}
        if(!fuelEvidence){entry.reason='FUEL_REQUIREMENT_UNVERIFIED';continue;}
        if(available<fuelEvidence.fuelLbs){entry.reason='FUEL_STOCK_INSUFFICIENT_BY_VERIFIED_HISTORY';continue;}
      }
      const reserveDemand=()=>{
        if(!validDemandCabins(decision.possiblePassengers))return;
        const current=poolRemaining.get(key);
        if(current)poolRemaining.set(key,subtractCabins(current,decision.possiblePassengers));
      };
      if(this.settings.dryRun){
        this.attemptedAircraft.add(fresh.aircraftId);this.attemptedRoutes.add(fresh.routeId);
        entry.status='would_depart';reserveDemand();await persist();continue;
      }
      if(this.settings.mutationDeadlineEpochMs!==undefined&&
        Date.now()>this.settings.mutationDeadlineEpochMs-MUTATION_COMPLETION_RESERVE_MS){
        entry.reason='RUN_TIME_BUDGET_EXHAUSTED_BEFORE_MUTATION';continue;
      }
      this.attemptedAircraft.add(fresh.aircraftId);this.attemptedRoutes.add(fresh.routeId);
      entry.status='attempting';
      // A persistence failure throws BEFORE any click. A crash after this point must never be retried.
      await persist();
      const code=(error:unknown)=>{
        const message=error instanceof Error?error.message:'UNCLASSIFIED';
        return /^[A-Z0-9_:-]{1,120}$/.test(message)?message:'UNCLASSIFIED';
      };
      try {
        await this.port.depart(fresh);
      } catch(error) {
        entry.status='outcome_unknown';entry.reason='NO_RETRY_AFTER_CLICK_ATTEMPT:'+code(error);report.halted=true;
        await persist();continue;
      }
      try {
        const after=await this.port.confirm(fresh);
        if(!after)throw new Error('CONFIRMATION_MISSING');
        if(after.state!=='inflight')throw new Error('CONFIRM_STATE_NOT_INFLIGHT');
        if(after.issue)throw new Error('CONFIRM_AIRCRAFT_ISSUE');
        if(!sameContext(fresh,after))throw new Error('CONFIRM_CONTEXT_CHANGED');
        const timing=after.timing;
        if(!timing)throw new Error('CONFIRM_TIMING_MISSING');
        if(!after.onboard)throw new Error('CONFIRM_ONBOARD_MISSING');
        if(timing.source!=='inspected-flight-countdown')throw new Error('CONFIRM_TIMING_SOURCE_INVALID');
        if(timing.aircraftId!==fresh.aircraftId||timing.routeId!==fresh.routeId)throw new Error('CONFIRM_TIMING_ID_MISMATCH');
        if(!Number.isSafeInteger(timing.remainingSeconds)||timing.remainingSeconds<=0)throw new Error('CONFIRM_COUNTDOWN_INVALID');
        const age=Date.now()-Date.parse(timing.observedAt);
        if(!Number.isFinite(age)||age<0||age>this.demand.maxAgeSeconds*1000)throw new Error('CONFIRM_OBSERVATION_STALE');
        if((['Y','J','F'] as const).some(k=>!Number.isSafeInteger(after.onboard![k])||after.onboard![k]<0||after.onboard![k]>after.capacity![k]))
          throw new Error('CONFIRM_ONBOARD_INVALID');
        entry.status='departed';entry.actualOnboard=after.onboard;
        entry.estimatedGrossTicketRevenue=estimatedGrossTicketRevenue(after.onboard,fresh.fares);
        entry.reason='NATIVE_INFLIGHT_IDENTITY_COUNTDOWN_AND_ONBOARD_CONFIRMED';
        reserveDemand();
        if(this.settings.fuelHoldingLbsAtRunStart!==undefined){
          // A real departure cannot reach this point without verified fuel evidence.
          fuelCommitted+=fuelEvidence!.fuelLbs;
        }
      } catch(error) {
        entry.status='outcome_unknown';entry.reason='NO_RETRY_AFTER_CLICK_ATTEMPT:'+code(error);report.halted=true;
      }
      await persist();
    }
    // A limited first-page observation never establishes fleet-wide idleness.
    // Fail visibly rather than returning a misleading green 0-departure run
    // if no aircraft on the current first page could be assessed.
    if(this.settings.rollingIndividualMode&&
       (!rollingWindowVerified||initial.aircraft.length===0)){
      report.halted=true;
      await persist();
      throw Error('ROLLING_INDIVIDUAL_WINDOW_NO_VERIFIED_CANDIDATES');
    }
    report.completedAt=new Date().toISOString();await persist();return report;
  }
}
