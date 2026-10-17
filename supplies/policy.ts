export type Commodity = 'fuel' | 'co2';
export interface SupplyConfig {
  enabled:boolean; maxPrice:Record<Commodity,number>; maxQuantity:Record<Commodity,number>; minCashReserve:number;
}
export interface SupplySnapshot { pricePer1000:number; holding:number; remainingCapacity:number; balance:number }
export interface PurchasePlan { quantity:number; estimatedCost:number; budget:number; reason:string }
export function supplyConfig(env:NodeJS.ProcessEnv=process.env):SupplyConfig {
  const flag=(env.ENABLE_FUEL||'true').trim().toLowerCase();
  if(!['true','false','1','0','on','off','yes','no'].includes(flag))throw Error('SUPPLY_ENABLE_INVALID');
  const enabled=['true','1','on','yes'].includes(flag);
  const number=(name:string,fallback:number,min:number)=>{
    const raw=(env[name]||String(fallback)).trim();
    if(!/^\d+$/.test(raw))throw Error('SUPPLY_CONFIG_INVALID:'+name);
    const value=Number(raw);if(!Number.isSafeInteger(value)||value<min)throw Error('SUPPLY_CONFIG_INVALID:'+name);return value;
  };
  return {enabled,maxPrice:{fuel:number('MAX_FUEL_PRICE',enabled?550:0,enabled?1:0),co2:number('MAX_CO2_PRICE',enabled?120:0,enabled?1:0)},
    maxQuantity:{fuel:number('MAX_FUEL_PURCHASE_PER_RUN',0,0),co2:number('MAX_CO2_PURCHASE_PER_RUN',0,0)},
    minCashReserve:number('MIN_CASH_RESERVE',0,0)};
}
/** Prices are per 1,000 lbs / quotas. Zero quantity limit means available tank capacity. */
export function planPurchase(s:SupplySnapshot,kind:Commodity,c:SupplyConfig):PurchasePlan {
  const hold=(reason:string):PurchasePlan=>({quantity:0,estimatedCost:0,budget:0,reason});
  if(!c.enabled)return hold('DISABLED');
  if(!Number.isSafeInteger(s.pricePer1000)||s.pricePer1000<=0||
    !Number.isSafeInteger(s.remainingCapacity)||s.remainingCapacity<0||
    !Number.isSafeInteger(s.balance)||s.balance<0||
    !Number.isSafeInteger(s.holding)||
    (kind==='fuel'&&s.holding<0)||
    !Number.isSafeInteger(Math.max(0,s.holding)+s.remainingCapacity))return hold('INVALID_DATA');
  if(s.pricePer1000>c.maxPrice[kind])return hold('PRICE_ABOVE_LIMIT');
  // The game displays negative CO2 holding as debt, but reports the full
  // positive tank capacity as free. A purchase must repay that debt FIRST
  // and then fill the physical tank; capacity only decreases once holding
  // becomes positive. Never apply this rule to fuel.
  const deficit=kind==='co2'&&s.holding<0?-s.holding:0;
  const desiredQuantity=deficit+s.remainingCapacity;
  if(!Number.isSafeInteger(desiredQuantity)||desiredQuantity<0)return hold('INVALID_DATA');
  if(desiredQuantity===0)return hold('STORAGE_FULL');
  const available=Math.max(0,s.balance-c.minCashReserve);
  const target=Math.min(desiredQuantity,c.maxQuantity[kind]||desiredQuantity);
  const cost=Math.ceil(target*s.pricePer1000/1000);
  if(!Number.isSafeInteger(cost))return hold('INVALID_DATA');
  // Preserve original fuel policy: fill when affordable; otherwise spend at most half of available cash.
  const budget=cost<=available?available:Math.floor(available/2);
  const quantity=Math.min(target,Math.floor(budget*1000/s.pricePer1000));
  if(!Number.isSafeInteger(quantity)||quantity<=0)return hold('INSUFFICIENT_BUDGET');
  return {quantity,estimatedCost:Math.ceil(quantity*s.pricePer1000/1000),budget,reason:'PRICE_AND_BUDGET_ACCEPTED'};
}

/** Expected native inventory arithmetic: CO2 debt is repaid before tank space fills. */
export function expectedSupplyStockAfterPurchase(
  s:Pick<SupplySnapshot,'holding'|'remainingCapacity'>,
  kind:Commodity,quantity:number
):Pick<SupplySnapshot,'holding'|'remainingCapacity'> {
  const oldHolding=s.holding;
  if(!Number.isSafeInteger(oldHolding)||!Number.isSafeInteger(s.remainingCapacity)||
    s.remainingCapacity<0||!Number.isSafeInteger(quantity)||quantity<=0||
    (kind==='fuel'&&oldHolding<0))throw Error('SUPPLY_POST_PURCHASE_EXPECTATION_INVALID');
  const holding=oldHolding+quantity;
  const occupiedBefore=Math.max(0,oldHolding);
  const occupiedAfter=Math.max(0,holding);
  const remainingCapacity=s.remainingCapacity-(occupiedAfter-occupiedBefore);
  if(!Number.isSafeInteger(holding)||!Number.isSafeInteger(remainingCapacity)||
    remainingCapacity<0)throw Error('SUPPLY_POST_PURCHASE_EXPECTATION_INVALID');
  return {holding,remainingCapacity};
}

