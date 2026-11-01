import { test, expect } from '@playwright/test';
import { DemandManager } from '../../demand/manager';
import { readDemandConfig } from '../../demand/config';
import { AircraftSnapshot, CollectionResult } from '../../demand/types';
import { individualDepartureSelector, integerText, parseDemand, parseCapacity } from '../../demand/parsing';
import { withRunLock } from '../../utils/run-lock';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { markdownReport } from '../../demand/report';

const now = new Date('2026-09-29T15:00:00Z');
const config = readDemandConfig({});
function aircraft(overrides: Partial<AircraftSnapshot> = {}): AircraftSnapshot {
  return { aircraftId: '1', registration: 'TEST-1', routeId: '10', routeLabel: 'AAA - BBB', from: 'AAA', to: 'BBB', state: 'ready',
    capacity: { Y: 100, J: 0, F: 0 }, remaining: { Y: 100, J: 100, F: 100 }, dailyTotal: { Y: 1000, J: 1000, F: 1000 }, observedAt: now.toISOString(), ...overrides };
}
function collection(aircraft: AircraftSnapshot[], complete = true): CollectionResult { return { aircraft, complete, expectedRoutes: aircraft.length, warnings: [] }; }
function analyze(items: AircraftSnapshot[], overrides = {}) { return new DemandManager({ ...config, ...overrides }).analyze(collection(items), now); }

test('full demand authorizes simulation only', () => {
  const r = analyze([aircraft()]); expect(r.summary.sufficient).toBe(1); expect(r.decisions[0].occupancyPercentage).toBe(100);
  expect(r.decisions[0].departureAuthorized).toBe(false);
});
for (const [remaining, expected] of [[79, 'hold_insufficient'], [80, 'would_depart'], [0, 'hold_insufficient']] as const) {
  test(`partial/zero demand ${remaining}`, () => expect(analyze([aircraft({ remaining: { Y: remaining, J: 100, F: 100 } })]).decisions[0].decision).toBe(expected));
}
test('zero demand in configured cabins cannot use other cabins', () => {
  const d = analyze([aircraft({ remaining: { Y: 0, J: 1000, F: 1000 } })]).decisions[0]; expect(d.occupancyPercentage).toBe(0); expect(d.decision).toBe('hold_insufficient');
});
test('aggregate evaluates actual multi-class layout', () => {
  const a = aircraft({ capacity: { Y: 80, J: 10, F: 10 }, remaining: { Y: 80, J: 0, F: 0 } });
  expect(analyze([a]).decisions[0].decision).toBe('would_depart');
  expect(analyze([a], { mode: 'per-class' }).decisions[0].decision).toBe('hold_insufficient');
});
test('inactive cabins do not veto per-class decision', () => {
  expect(analyze([aircraft({ capacity: { Y: 0, J: 10, F: 0 }, remaining: { Y: 0, J: 8, F: 0 } })], { mode: 'per-class' }).summary.sufficient).toBe(1);
});
test('fractional threshold rounds required passengers up', () => {
  const d = analyze([aircraft({ capacity: { Y: 99, J: 0, F: 0 }, remaining: { Y: 79, J: 0, F: 0 } })]).decisions[0];
  expect(d.requiredPassengers).toBe(80); expect(d.decision).toBe('hold_insufficient');
});
test('two aircraft reserve the same demand only once', () => {
  const items = [aircraft(), aircraft({ aircraftId: '2', routeId: '20' })];
  const r = analyze(items); expect(r.summary.sufficient).toBe(1); expect(r.summary.insufficient).toBe(1);
  expect(r.decisions[1].availableBefore?.Y).toBe(0); expect(items[0].remaining?.Y).toBe(100);
});
test('reserves per cabin, not only threshold or pooled seats', () => {
  const one = aircraft({ capacity: { Y: 80, J: 10, F: 10 }, remaining: { Y: 100, J: 10, F: 10 } });
  const two = { ...one, aircraftId: '2', routeId: '20' };
  expect(analyze([one, two]).decisions[1].availableBefore).toEqual({ Y: 20, J: 0, F: 0 });
});
test('insufficient aircraft does not consume a reservation', () => {
  const one = aircraft({ capacity: { Y: 200, J: 0, F: 0 } });
  expect(analyze([one, aircraft({ aircraftId: '2', routeId: '20' })]).decisions[1].decision).toBe('would_depart');
});
test('minimum across multiple observations is conservative', () => {
  const r = analyze([aircraft(), aircraft({ aircraftId: '2', routeId: '20', remaining: { Y: 70, J: 100, F: 100 } })]);
  expect(r.summary.sufficient).toBe(0); expect(r.decisions[0].availableBefore?.Y).toBe(70);
});
test('opposite directions share conservative pool by default; explicit directional is separate', () => {
  const items = [aircraft(), aircraft({ aircraftId: '2', routeId: '20', from: 'BBB', to: 'AAA' })];
  expect(analyze(items).summary.sufficient).toBe(1); expect(analyze(items, { poolScope: 'directional' }).summary.sufficient).toBe(2);
});
test('independent airport pairs do not share reservations', () => {
  expect(analyze([aircraft(), aircraft({ aircraftId: '2', routeId: '20', to: 'CCC' })]).summary.sufficient).toBe(2);
});
test('renewed demand is reconsidered on subsequent analysis', () => {
  const manager = new DemandManager(config);
  expect(manager.analyze(collection([aircraft({ remaining: { Y: 0, J: 0, F: 0 } })]), now).summary.sufficient).toBe(0);
  expect(manager.analyze(collection([aircraft()]), now).summary.sufficient).toBe(1);
  expect(manager.analyze(collection([aircraft()]), now).summary.sufficient).toBe(1);
});
for (const [label, patch] of Object.entries({
  missing: { remaining: null }, noCapacity: { capacity: null }, zeroCapacity: { capacity: { Y: 0, J: 0, F: 0 } },
  negative: { remaining: { Y: -1, J: 0, F: 0 } }, nan: { remaining: { Y: NaN, J: 0, F: 0 } },
  infinity: { capacity: { Y: Infinity, J: 0, F: 0 } }, fraction: { capacity: { Y: 1.5, J: 0, F: 0 } },
  inconsistent: { remaining: { Y: 1001, J: 0, F: 0 } }, stale: { observedAt: '2026-09-29T14:00:00Z' },
  future: { observedAt: '2026-09-29T15:01:00Z' }, badTime: { observedAt: 'invalid' }, badRoute: { from: '' },
  loadFailure: { issue: 'Falha de carregamento' },
})) test(`fail closed: ${label}`, () => expect(analyze([aircraft(patch)]).summary.unavailable).toBe(1));
test('different daily totals invalidate entire pool', () => {
  expect(analyze([aircraft(), aircraft({ aircraftId: '2', routeId: '20', dailyTotal: { Y: 900, J: 1000, F: 1000 } })]).summary.unavailable).toBe(2);
});
test('duplicate aircraft and duplicate route cannot be approved', () => {
  expect(analyze([aircraft(), aircraft({ routeId: '20' })]).summary.unavailable).toBe(2);
  expect(analyze([aircraft(), aircraft({ aircraftId: '2' })]).summary.unavailable).toBe(2);
});
test('inflight and unavailable state never depart', () => {
  expect(analyze([aircraft({ state: 'inflight' })]).summary.notReady).toBe(1);
  expect(analyze([aircraft({ state: 'unavailable' })]).summary.unavailable).toBe(1);
});
test('incomplete collection blocks all simulated departures', () => {
  expect(new DemandManager(config).analyze(collection([aircraft()], false), now).summary.unavailable).toBe(1);
});
test('disabled manager returns no authorization', () => expect(analyze([aircraft()], { enabled: false }).summary.sufficient).toBe(0));
test('configuration defaults to protected simulation', () => {
  expect(config).toMatchObject({ enabled: true, dryRun: true, failSafe: true, minPercentage: 80 });
  expect(readDemandConfig({ ENABLE_DEMAND_MANAGER: 'false' }).enabled).toBe(false);
});
for (const env of [{ DEMAND_DRY_RUN: 'false' }, { DEMAND_FAIL_SAFE: 'false' }, { ENABLE_DEMAND_MANAGER: 'tru' }, { MIN_DEMAND_PERCENTAGE: '0' }, { MIN_DEMAND_PERCENTAGE: '101' }, { MIN_DEMAND_PERCENTAGE: 'NaN' }, { DEMAND_POOL_SCOPE: 'guess' }, { DEMAND_THRESHOLD_MODE: 'unknown' }, { DEMAND_MAX_AGE_SECONDS: '-1' }]) {
  test(`invalid config ${JSON.stringify(env)}`, () => expect(() => readDemandConfig(env)).toThrow());
}
test('parsers reject partial, locale-ambiguous and negative numbers', () => {
  expect(integerText('1,234')).toBe(1234);
  for (const t of ['12oops', '1.234', '-1', '1,2', '', 'NaN', '1e3']) expect(() => integerText(t)).toThrow();
  expect(parseCapacity({ Y: '99', J: '0', F: '0' })).toEqual({ Y: 99, J: 0, F: 0 });
  expect(parseDemand({ Y: '34/993', J: '196/196', F: '83/83' })).toMatchObject({
    remaining:{Y:34,J:196,F:83},dailyTotal:{Y:993,J:196,F:83}
  });
  expect(parseDemand({ Y: '993/34', J: '196/196', F: '83/83' })).toMatchObject({
    remaining:{Y:34,J:196,F:83},dailyTotal:{Y:993,J:196,F:83}
  });
  expect(parseDemand({ Y: '35/34', J: '0/0', F: '0/0' })).toMatchObject({
    remaining:{Y:34,J:0,F:0},dailyTotal:{Y:35,J:0,F:0}
  });
  expect(() => parseDemand({ Y: '34', J: '0/0', F: '0/0' })).toThrow();
});
test('individual target validates identity and never clicks', () => {
  expect(individualDepartureSelector('123')).toBe('#routeMainList123 #listDepart123');
  expect(() => individualDepartureSelector('1, #departAll')).toThrow();
});
test('report contains class demand, capacities and reasons', () => {
  const r = analyze([aircraft()]); const md = markdownReport(r);
  expect(md).toContain('100 / 100 / 100'); expect(md).toContain('100 / 0 / 0'); expect(md).toContain('would_depart');
  expect(JSON.parse(JSON.stringify(r)).decisions[0].departureAuthorized).toBe(false);
});
test('local lock rejects overlapping runs and releases after errors', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'am4-lock-')); const lock = join(dir, 'lock');
  try {
    await withRunLock(async () => { await expect(withRunLock(async () => {}, lock)).rejects.toThrow('Lock'); }, lock);
    await expect(withRunLock(async () => { throw new Error('fixture failure'); }, lock)).rejects.toThrow('fixture failure');
    await withRunLock(async () => {}, lock);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('Telegram message is aggregate-only and silent when healthy', () => {
  const { message } = require('../../scripts/telegram-demand.cjs');
  expect(message(analyze([aircraft()]))).toBeNull();
  const report = analyze([aircraft({ remaining: { Y: 0, J: 0, F: 0 }, registration: 'PRIVATE-NAME' })]);
  const text = message(report);
  expect(text).toContain('insuficientes 1'); expect(text).not.toContain('PRIVATE-NAME'); expect(text).not.toContain('AAA');
  expect(() => message({ summary: { evaluated: 'oops' } })).toThrow();
});

test('adaptive threshold only raises floor after enough verified history',async()=>{
  const {adaptiveDemandThresholds,adaptiveDemandKey}=await import('../../demand/adaptive-threshold');
  const events=[80,95,94,93,92,91].map((p,i)=>({eventId:'e'+i,type:'departure' as const,aircraftId:'1',registration:'T',routeId:'10',from:'AAA',to:'BBB',observedAt:now.toISOString(),result:'departed' as const,demand:{availableBefore:{Y:100,J:0,F:0},possiblePassengers:{Y:p,J:0,F:0},occupancyPercentage:p},actualOnboard:{Y:p,J:0,F:0}}));
  expect(adaptiveDemandThresholds({schemaVersion:1,scope:'x',entries:[],events:events.slice(0,4)},80).size).toBe(0);
  const map=adaptiveDemandThresholds({schemaVersion:1,scope:'x',entries:[],events:events.slice(1)},80);
  expect(map.get(adaptiveDemandKey('1','10'))).toEqual({percentage:90,source:'verified-departure-history',samples:5});
  const r=new DemandManager(config,map).analyze(collection([aircraft({remaining:{Y:85,J:0,F:0}})]),now);
  expect(r.decisions[0]).toMatchObject({decision:'hold_insufficient',thresholdPercentage:90,thresholdSource:'verified-departure-history'});
});
test('adaptive history never lowers configured threshold',async()=>{
  const {adaptiveDemandThresholds}=await import('../../demand/adaptive-threshold');
  const events=[70,71,72,73,74].map((p,i)=>({eventId:'l'+i,type:'departure' as const,aircraftId:'1',registration:'T',routeId:'10',from:'AAA',to:'BBB',observedAt:now.toISOString(),result:'departed' as const,demand:{availableBefore:{Y:100,J:0,F:0},possiblePassengers:{Y:p,J:0,F:0},occupancyPercentage:p},actualOnboard:{Y:p,J:0,F:0}}));
  expect(adaptiveDemandThresholds({schemaVersion:1,scope:'x',entries:[],events},80).size).toBe(0);
});

test('Telegram production summary is aggregate and emitted on healthy runs',async()=>{
 const fs=await import('node:fs/promises'),os=await import('node:os'),path=await import('node:path');const dir=await fs.mkdtemp(path.join(os.tmpdir(),'am4-tgs-'));const {runSummaryMessage}=require('../../scripts/telegram-demand.cjs');
 try{
  await fs.writeFile(path.join(dir,'company-dashboard.json'),JSON.stringify({
   bases:{status:'observed',effective:['XAP','GRU','DTW','TXL'],source:'research_main.php#hubSelect'},
   fleet:{seen:32,ready:3,inflight:29},
   demand:{evaluated:3,sufficient:3,insufficient:0,unavailable:0},
   departures:{evaluated:3,departed:2,held:1,unknown:0},
   pricing:{adjusted:0,unchanged:3,unknown:0},
   routes:{rerouted:0,reviewDecisions:{keep:0,hold:1,wouldReroute:0}},
   supplies:{fuel:{status:'skipped',reason:'PRICE_NOT_BELOW_LIMIT'},co2:{status:'skipped',reason:'PERSISTED_UNCERTAIN_SUPPLY_BLOCK'}},
   quarantines:{departure:3,route:0,pricingRoute:0,supplyKinds:1},
   uiHealth:{status:'healthy'}
  }));
  const text=runSummaryMessage(dir,'success');
  expect(text).toContain('AIRLINE MANAGER 4');expect(text).toContain('SUCESSO');expect(text).toContain('Bases observadas: XAP, GRU, DTW, TXL');expect(text).toContain('Decolagens: 2/3 confirmadas');expect(text).toContain('Pricing: 0 ajustadas | 3 no alvo');expect(text).toContain('Segurança: quarentenas');expect(text).not.toContain('21038003');
 }finally{await fs.rm(dir,{recursive:true,force:true});}
});
test('Telegram important events stays silent on ordinary holds and reports only actionable evidence',async()=>{
 const fs=await import('node:fs/promises'),os=await import('node:os'),path=await import('node:path');const dir=await fs.mkdtemp(path.join(os.tmpdir(),'am4-tg-'));const {importantMessage}=require('../../scripts/telegram-demand.cjs');
 try{await fs.writeFile(path.join(dir,'demand-report.json'),JSON.stringify({decisions:[{decision:'hold_insufficient',occupancyPercentage:25}]}));expect(importantMessage(dir,'success')).toBeNull();
 await fs.writeFile(path.join(dir,'ui-health.json'),JSON.stringify({status:'UI_CHANGE_DETECTED'}));expect(importantMessage(dir,'failure')).toContain('UI_CHANGE_DETECTED');
 await fs.writeFile(path.join(dir,'route-execution.json'),JSON.stringify({summary:{rerouted:1,unknown:0},halted:false}));expect(importantMessage(dir,'success')).toContain('rotas alteradas e confirmadas: 1');
 await fs.writeFile(path.join(dir,'execution-report.json'),JSON.stringify({summary:{unknown:0},halted:false,entries:[{status:'held',reason:'FUEL_STOCK_INSUFFICIENT_BY_VERIFIED_HISTORY'}]}));expect(importantMessage(dir,'success')).toContain('combustivel insuficiente verificado: 1');
 await fs.writeFile(path.join(dir,'supply-report.json'),JSON.stringify({halted:false,adaptive:{fuel:{source:'verified-live-history',historicalReference:400}},entries:[{kind:'fuel',status:'purchased',before:{pricePer1000:350}}]}));expect(importantMessage(dir,'success')).toContain('combustivel materialmente barato');}finally{await fs.rm(dir,{recursive:true,force:true});}
});

test('Telegram critical maintenance reuses verified operational thresholds',async()=>{
 const fs=await import('node:fs/promises'),os=await import('node:os'),path=await import('node:path');const dir=await fs.mkdtemp(path.join(os.tmpdir(),'am4-tgm-'));const {importantMessage}=require('../../scripts/telegram-demand.cjs');
 try{await fs.writeFile(path.join(dir,'candidate-data.json'),JSON.stringify({maintenance:{status:'observed',complete:true,aircraft:[{hoursToCheck:20,wearPercentage:10},{hoursToCheck:100,wearPercentage:31}]}}));expect(importantMessage(dir,'success')).toContain('manutencao critica pela politica verificada: 2');}finally{await fs.rm(dir,{recursive:true,force:true});}
});

test('Telegram prolonged hold requires verified duration after last confirmed departure',async()=>{
 const fs=await import('node:fs/promises'),os=await import('node:os'),path=await import('node:path');const dir=await fs.mkdtemp(path.join(os.tmpdir(),'am4-tgh-'));const {importantMessage}=require('../../scripts/telegram-demand.cjs');const jp=path.join(dir,'journal.json');
 try{const hold=(id:string,time:string)=>({eventId:id,type:'demand-hold',aircraftId:'1',routeId:'10',observedAt:time,occupancyPercentage:20,reason:'hold_insufficient'});await fs.writeFile(jp,JSON.stringify({schemaVersion:1,scope:'x',entries:[],holdObservations:[hold('h1','2026-10-03T10:00:00Z'),hold('h2','2026-10-03T13:00:00Z')]}));expect(importantMessage(dir,'success',jp)).toContain('holds prolongados com duracao verificada: 1');await fs.writeFile(jp,JSON.stringify({schemaVersion:1,scope:'x',entries:[],events:[{aircraftId:'1',routeId:'10',observedAt:'2026-10-03T12:00:00Z'}],holdObservations:[hold('h1','2026-10-03T10:00:00Z'),hold('h2','2026-10-03T13:00:00Z')]}));expect(importantMessage(dir,'success',jp)).toBeNull();}finally{await fs.rm(dir,{recursive:true,force:true});}
});
