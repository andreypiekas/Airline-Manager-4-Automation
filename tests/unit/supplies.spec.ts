import {test,expect} from '@playwright/test';
import {planPurchase,supplyConfig,expectedSupplyStockAfterPurchase} from '../../supplies/policy';
const c=supplyConfig({MAX_FUEL_PRICE:'550',MAX_CO2_PRICE:'120'});
const s={pricePer1000:500,holding:1000,remainingCapacity:100000,balance:100000};
test('fills available fuel capacity below the cap',()=>expect(planPurchase(s,'fuel',c)).toMatchObject({quantity:100000,estimatedCost:50000}));
test('Fuel buys at the configured ceiling and blocks only above it',()=>{
 expect(planPurchase({...s,holding:0,pricePer1000:550},'fuel',c).quantity).toBeGreaterThan(0);
 expect(planPurchase({...s,holding:0,pricePer1000:551},'fuel',c).reason).toBe('PRICE_ABOVE_LIMIT');
});
test('CO2 buys at or below the configured ceiling and blocks only above it',()=>{
 expect(planPurchase({...s,pricePer1000:119},'co2',c).quantity).toBe(100000);
 expect(planPurchase({...s,pricePer1000:120},'co2',c).quantity).toBe(100000);
 expect(planPurchase({...s,pricePer1000:121},'co2',c).reason).toBe('PRICE_ABOVE_LIMIT');
 expect(planPurchase({...s,pricePer1000:100,balance:100},'co2',c)).toMatchObject({quantity:500,estimatedCost:50});
});
test('volume limit, reserve and full storage are respected',()=>{
 const cfg=supplyConfig({MAX_FUEL_PURCHASE_PER_RUN:'2000',MIN_CASH_RESERVE:'1000'});
 expect(planPurchase({...s,balance:2000},'fuel',cfg)).toMatchObject({quantity:2000,estimatedCost:1000});
 expect(planPurchase({...s,balance:1000},'fuel',cfg).quantity).toBe(0);
 expect(planPurchase({...s,remainingCapacity:0},'fuel',cfg).reason).toBe('STORAGE_FULL');
});
for(const value of [NaN,-1,Infinity,0.5])test(`inconsistent supply values rejected: ${value}`,()=>expect(planPurchase({...s,balance:value},'fuel',c).reason).toBe('INVALID_DATA'));
test('unaffordable tank uses half budget and rounds quantity down',()=>expect(planPurchase({...s,balance:1001},'fuel',c)).toMatchObject({quantity:1000,estimatedCost:500,budget:500}));
test('zero price rejected; disabled flow holds',()=>{
 expect(planPurchase({...s,pricePer1000:0},'fuel',c).reason).toBe('INVALID_DATA');
 expect(planPurchase(s,'fuel',supplyConfig({ENABLE_FUEL:'false'})).reason).toBe('DISABLED');
});
for(const env of [{MAX_FUEL_PRICE:'550oops'},{MAX_CO2_PRICE:'0'},{MAX_FUEL_PURCHASE_PER_RUN:'-1'},{MIN_CASH_RESERVE:'NaN'},{ENABLE_FUEL:'maybe'}])test(`bad config ${JSON.stringify(env)}`,()=>expect(()=>supplyConfig(env)).toThrow());

test('verified supply history can only tighten the configured cap',async()=>{
 const {adaptiveSupplyCap}=await import('../../supplies/adaptive-policy');
 const obs=[300,320,340,360,500].map((pricePer1000,i)=>({eventId:'s'+i,type:'supply-observation' as const,kind:'fuel' as const,observedAt:'2026-09-29T15:00:00Z',pricePer1000,holding:1,remainingCapacity:1,balance:1}));
 expect(adaptiveSupplyCap({schemaVersion:1,scope:'x',entries:[],supplyObservations:obs.slice(0,4)},'fuel',550)).toMatchObject({effectiveMax:550,source:'configured-cap',samples:4});
 expect(adaptiveSupplyCap({schemaVersion:1,scope:'x',entries:[],supplyObservations:obs},'fuel',550)).toEqual({configuredMax:550,effectiveMax:440,source:'verified-live-history',samples:5,historicalReference:320});
});
test('adaptive supply cap is bounded and never raises configured ceiling',async()=>{
 const {adaptiveSupplyCap}=await import('../../supplies/adaptive-policy');
 const mk=(p:number,i:number)=>({eventId:'h'+i,type:'supply-observation' as const,kind:'fuel' as const,observedAt:'2026-09-29T15:00:00Z',pricePer1000:p,holding:1,remainingCapacity:1,balance:1});
 expect(adaptiveSupplyCap({schemaVersion:1,scope:'x',entries:[],supplyObservations:[100,110,120,130,140].map(mk)},'fuel',550).effectiveMax).toBe(440);
 expect(adaptiveSupplyCap({schemaVersion:1,scope:'x',entries:[],supplyObservations:[700,710,720,730,740].map(mk)},'fuel',550).effectiveMax).toBe(550);
});

test('negative CO2 stock at 104 (configured max 120) repays deficit and fills available tank',()=>{
 const snapshot={pricePer1000:104,holding:-13_013_699,remainingCapacity:10_050_500,balance:168_815_066};
 const plan=planPurchase(snapshot,'co2',c);
 expect(plan.reason).toBe('PRICE_AND_BUDGET_ACCEPTED');
 expect(plan.quantity).toBe(23_064_199);
 expect(plan.estimatedCost).toBe(Math.ceil(23_064_199*104/1000));
 expect(expectedSupplyStockAfterPurchase(snapshot,'co2',plan.quantity)).toEqual({
   holding:10_050_500,remainingCapacity:0
 });
 expect(planPurchase({...snapshot,pricePer1000:120},'co2',c).quantity).toBe(23_064_199);
 expect(planPurchase({...snapshot,pricePer1000:121},'co2',c).reason).toBe('PRICE_ABOVE_LIMIT');
});
test('negative CO2 purchase cap can partially repay deficit without changing free tank capacity',()=>{
 const snapshot={pricePer1000:100,holding:-13_013_699,remainingCapacity:10_050_500,balance:168_815_066};
 const limited=supplyConfig({MAX_CO2_PRICE:'120',MAX_CO2_PURCHASE_PER_RUN:'10_000'.replace('_','')});
 const plan=planPurchase(snapshot,'co2',limited);
 expect(plan.quantity).toBe(10_000);
 expect(expectedSupplyStockAfterPurchase(snapshot,'co2',plan.quantity)).toEqual({
  holding:-13_003_699,remainingCapacity:10_050_500
 });
 expect(expectedSupplyStockAfterPurchase(snapshot,'co2',13_013_700)).toEqual({
  holding:1,remainingCapacity:10_050_499
 });
 expect(expectedSupplyStockAfterPurchase(snapshot,'co2',23_064_199)).toEqual({
  holding:10_050_500,remainingCapacity:0
 });
});
test('negative CO2 never bypasses cash reserve, quantity ceiling or safe-number arithmetic',()=>{
 const stock={pricePer1000:104,holding:-13_013_699,remainingCapacity:10_050_500,balance:0};
 expect(planPurchase(stock,'co2',c).reason).toBe('INSUFFICIENT_BUDGET');
 expect(planPurchase({...stock,balance:100},'co2',c).quantity).toBeGreaterThan(0);
 expect(planPurchase({...stock,balance:100},'co2',c).quantity).toBeLessThan(-stock.holding);
 expect(planPurchase({...stock,holding:-Number.MAX_SAFE_INTEGER},'co2',c).reason).toBe('INVALID_DATA');
 expect(()=>expectedSupplyStockAfterPurchase(stock,'co2',23_064_200)).toThrow('SUPPLY_POST_PURCHASE_EXPECTATION_INVALID');
 expect(planPurchase({...stock,pricePer1000:104,holding:0,remainingCapacity:0,balance:100},'co2',c).reason).toBe('STORAGE_FULL');
});

test('explicit CO2 price ceiling is not silently lowered by historical adaptive cap',async()=>{
 const {supplyCapsForRun}=await import('../../supplies/run');
 const obs=[40,50,60,70,80].map((pricePer1000,i)=>({
  eventId:'co2-s'+i,type:'supply-observation' as const,kind:'co2' as const,
  observedAt:'2026-10-16T20:00:00Z',pricePer1000,holding:100,
  remainingCapacity:10_000,balance:1_000_000
 }));
 const configured=supplyConfig({MAX_CO2_PRICE:'120',MAX_FUEL_PRICE:'550'});
 const caps=supplyCapsForRun({schemaVersion:1,scope:'test',entries:[],supplyObservations:obs},configured);
 expect(caps.co2.effectiveMax).toBe(120);
 expect(caps.co2.source).toBe('configured-cap');
 const snapshot={pricePer1000:104,holding:-13_013_699,remainingCapacity:10_050_500,balance:168_815_066};
 const actualConfig={...configured,maxPrice:{fuel:caps.fuel.effectiveMax,co2:caps.co2.effectiveMax}};
 expect(planPurchase(snapshot,'co2',actualConfig).quantity).toBe(23_064_199);
});
