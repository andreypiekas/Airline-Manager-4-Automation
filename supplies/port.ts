import {expect, Page} from '@playwright/test';
import {closeReadOnlyPopup} from '../optimization/cost-reference-reader';
import {Commodity, SupplySnapshot, expectedSupplyStockAfterPurchase} from './policy';
import {assertNoInteractiveChallenge} from '../utils/challenge-guard';
const normalize=(s:string)=>s.replace(/\s/g,'');
export class SupplyPreMutationError extends Error {
 constructor(readonly code:string){super(code);this.name='SupplyPreMutationError';}
}
export const purchaseCallback=(kind:Commodity)=>`Ajax('${kind}.php?mode=do&amount='+$('#amountInput').val(),'runme',this); playSound('currency_spend')`;
export function parseAmount(text:string):number {
 const s=text.trim().replace(/^\$\s*/,'');
 if(!/^(?:\d+|\d{1,3}(?:,\d{3})+)(?:\.\d{1,2})?$/.test(s))throw Error('SUPPLY_NUMBER_INVALID');
 const n=Number(s.replace(/,/g,''));if(!Number.isFinite(n)||n<0||n>Number.MAX_SAFE_INTEGER)throw Error('SUPPLY_NUMBER_INVALID');return n;
}
export function parseSignedInteger(text:string):number {
 const s=text.trim();
 if(!/^-?(?:\d+|\d{1,3}(?:,\d{3})+)$/.test(s))throw Error('SUPPLY_NUMBER_INVALID');
 const n=Number(s.replace(/,/g,''));if(!Number.isSafeInteger(n))throw Error('SUPPLY_NUMBER_INVALID');return n;
}

export interface SupplyQuote { total:number; discountPercent:number }
/** Accept a live discount only when its visible percentage and total reconcile. */
export function parseSupplyQuote(text:string,pricePer1000:number,quantity:number):SupplyQuote {
 const sections=[...text.matchAll(/TOTAL PRICE[\s\S]{0,160}?AMOUNT TO PURCHASE/gi)];
 if(sections.length!==1)throw Error('SUPPLY_QUOTE_MISSING');
 const match=/^TOTAL PRICE\s+\$\s*([\d,.]+)(?:\s*-(\d{1,2})%)?\s+AMOUNT TO PURCHASE$/i.exec(sections[0][0].trim());
 if(!match)throw Error('SUPPLY_QUOTE_UNVERIFIED');
 const discountPercent=match[2]===undefined?0:Number(match[2]);
 if(!Number.isSafeInteger(quantity)||quantity<=0||!Number.isSafeInteger(pricePer1000)||pricePer1000<=0||
    !Number.isSafeInteger(discountPercent)||discountPercent<0||discountPercent>=100)throw Error('SUPPLY_QUOTE_UNVERIFIED');
 const total=parseAmount(match[1]);
 const expected=pricePer1000*quantity/1000*(1-discountPercent/100);
 if(!Number.isFinite(expected)||expected<=0||Math.abs(total-expected)>=1)throw Error('SUPPLY_QUOTE_INCONSISTENT');
 return {total,discountPercent};
}

export function parseSupplyText(text:string,kind:Commodity,balance:number):SupplySnapshot {
 const one=(re:RegExp)=>{
  const matches=[...text.matchAll(re)];
  if(matches.length!==1)throw Error('SUPPLY_DATA_UNVERIFIED');
  return matches[0];
 };
 // AM4 may insert explanatory/status text between labels and values. Keep each
 // read bounded to the local section and require exactly one matching section.
 const price=one(kind==='fuel'
  ? /CURRENT PRICE[\s\S]{0,160}?\$\s*([\d,]+)(?=[\s\S]{0,120}?PRICE CHANGE)/gi
  : /QUOTA COST[\s\S]{0,160}?\$\s*([\d,]+)(?=[\s\S]{0,120}?PRICE CHANGE)/gi);
 const capacity=one(/CAPACITY[\s\S]{0,160}?([\d,]+)\s*\/\s*([\d,]+)\s+(Lbs|Quotas)/gi);
 const holding=one(/HOLDING[\s\S]{0,160}?(-?[\d,]+)\s+(Lbs|Quotas)/gi);
 const unit=kind==='fuel'?'lbs':'quotas';
 if(capacity[3].toLowerCase()!==unit||holding[2].toLowerCase()!==unit)throw Error('SUPPLY_DATA_UNVERIFIED');
 const remainingCapacity=parseAmount(capacity[1]),total=parseAmount(capacity[2]);
 const stock=kind==='co2'?parseSignedInteger(holding[1]):parseAmount(holding[1]);
 // Live CO2 can be negative while storage still reports 100% free capacity.
 // Negative quota debt does not occupy storage; positive holding does.
 const occupied=kind==='co2'?Math.max(0,stock):stock;
 if(total!==remainingCapacity+occupied)throw Error('SUPPLY_CAPACITY_INCONSISTENT');
 return {pricePer1000:parseAmount(price[1]),holding:stock,remainingCapacity,balance};
}
export class SupplyPort {
 constructor(private page:Page,private timeout=10000){}
 async diagnostic(kind:Commodity){
  try{
   const panel=this.page.locator('#fuelMain');
   if(await panel.count()!==1||!await panel.isVisible())return null;
   const rows=await panel.locator('div,span,b,label,input,button').evaluateAll(elements=>{
    const clean=(s:string|null|undefined)=>String(s||'').replace(/\s+/g,' ').trim();
    const relevant=/(current price|quota cost|price change|capacity|holding|total price|amount to purchase|lbs|quotas|fuel price|co2 quota)/i;
    return elements.flatMap(e=>{
      if(!e.getClientRects().length)return [];
      const text=clean((e as HTMLElement).innerText||e.textContent);
      const value=e instanceof HTMLInputElement?clean(e.value):'';
      const id=clean(e.getAttribute('id'));
      const hay=[text,value,id].filter(Boolean).join(' ');
      if(!relevant.test(hay))return [];
      return [{
        tag:e.tagName.toLowerCase(),
        id:id.slice(0,80)||null,
        text:text.slice(0,180)||null,
        value:value.slice(0,80)||null,
        classShape:clean(e.getAttribute('class')).slice(0,120)||null
      }];
    }).slice(0,80);
   });
   const panelText=(await panel.innerText()).split(/\r?\n/).map(s=>s.trim()).filter(Boolean)
     .filter(s=>/(current price|quota cost|price change|capacity|holding|total price|amount to purchase|lbs|quotas|fuel price|co2 quota|^\$?\s*[\d,.]+(?:\s*\/\s*[\d,.]+)?(?:\s+(?:lbs|quotas))?$)/i.test(s))
     .slice(0,80);
   // Redact all numeric digits: the account formatting shape helps diagnose
   // UI changes without persisting the user's actual balance.
   const account=this.page.locator('#headerAccount');
   const accountShape=await account.count()===1
    ?(await account.innerText()).replace(/\d+/g,'#').replace(/[A-Za-zÀ-ÿ]+/g,'A')
     .replace(/\s+/g,' ').replace(/[^#A$.,+\\-\\s]/g,'?').trim().slice(0,80):null;
   return {kind,rows,panelText,accountShape,mutationAuthorized:false as false};
  }catch{return null;}
 }
 async open(kind:Commodity){
  await assertNoInteractiveChallenge(this.page,'supplies:open');
  await closeReadOnlyPopup(this.page,this.timeout);
  const menu=this.page.locator('#smallMainMenu').getByText('Fuel',{exact:true}).locator('../..');
  if(await menu.count()!==1||!await menu.isVisible()||normalize(await menu.getAttribute('onclick')||'')!=="hideAllWhenClick();popup('fuel.php','Fuel',false,false,true);")throw Error('SUPPLY_MENU_UNVERIFIED');
  await menu.click({timeout:this.timeout});
  await this.page.locator('#fuelMain').getByText('Current price',{exact:true}).waitFor({timeout:this.timeout});
  if(kind==='co2'){
   const tab=this.page.locator('#popBtn2');
   const expected="$('.popMenuBtn').removeClass('active');$(this).addClass('active');$('#detailsAction').hide();Ajax('co2.php','fuelMain',this,false,false);";
   await expect.poll(async()=>{
    if(await tab.count()!==1||!await tab.isVisible())return false;
    return normalize(await tab.getAttribute('onclick')||'')===normalize(expected);
   },{timeout:this.timeout}).toBe(true);
   await tab.click({timeout:this.timeout});
   await this.page.locator('#fuelMain').getByText('Quota cost',{exact:true}).waitFor({timeout:this.timeout});
  }
 }
 async snapshot(kind:Commodity):Promise<SupplySnapshot>{
  const panel=this.page.locator('#fuelMain'),account=this.page.locator('#headerAccount');
  if(await panel.count()!==1||!await panel.isVisible()||await account.count()!==1||!await account.isVisible())throw Error('SUPPLY_PANEL_UNVERIFIED');
  const label=kind==='fuel'?'Fuel price per 1,000 Lbs':'Co2 quota cost per 1,000';
  if(await panel.getByText(label,{exact:true}).count()!==1)throw Error('SUPPLY_UNIT_UNVERIFIED');
  // A displayed account balance can change formatting independently of the
  // supply panel. Never infer or round an abbreviated amount before purchase.
  let balance:number;
  try{balance=parseAmount(await account.innerText());}
  catch{throw new SupplyPreMutationError('SUPPLY_BALANCE_FORMAT_UNVERIFIED');}
  return parseSupplyText(await panel.innerText(),kind,balance);
 }
 async verifyControl(kind:Commodity){
  const panel=this.page.locator('#fuelMain');
  const button=panel.getByRole('button',{name:/^(?:\S\s*)?Purchase$/i});
  const input=panel.getByPlaceholder('Amount to purchase',{exact:true});
  if(await button.count()!==1||!await button.isVisible()||!await button.isEnabled()||
   normalize(await button.getAttribute('onclick')||'')!==normalize(purchaseCallback(kind))||
   await input.count()!==1||await input.getAttribute('id')!=='amountInput'||await input.getAttribute('type')!=='tel')throw Error('SUPPLY_PURCHASE_CONTROL_UNVERIFIED');
  return {button,input};
 }
 async quote(kind:Commodity,quantity:number){
  await assertNoInteractiveChallenge(this.page,'supplies:quote');
  const {input}=await this.verifyControl(kind);
  await input.fill(String(quantity),{timeout:this.timeout});await input.press('ArrowRight',{timeout:this.timeout});
  const pricePer1000=(await this.snapshot(kind)).pricePer1000;
  const read=async()=>parseSupplyQuote(await this.page.locator('#fuelMain').innerText(),pricePer1000,quantity);
  // The game can render the total asynchronously after the amount changes.
  // Never click Purchase unless the visible total and discount reconcile.
  await expect.poll(async()=>{try{await read();return true;}catch{return false;}},{timeout:this.timeout}).toBe(true);
  return read();
 }
 async purchase(kind:Commodity,quantity:number,before:SupplySnapshot,quote:SupplyQuote){
  let mutationAttempted=false;
  try{
   await assertNoInteractiveChallenge(this.page,'supplies:before-purchase');
   const {button,input}=await this.verifyControl(kind);
   if(await input.inputValue()!==String(quantity))throw Error('SUPPLY_AMOUNT_CHANGED');
   const fresh=await this.snapshot(kind);
   if(JSON.stringify(fresh)!==JSON.stringify(before))throw Error('SUPPLY_SNAPSHOT_CHANGED');
   const freshQuote=parseSupplyQuote(await this.page.locator('#fuelMain').innerText(),fresh.pricePer1000,quantity);
   if(freshQuote.total!==quote.total||freshQuote.discountPercent!==quote.discountPercent)throw Error('SUPPLY_QUOTE_CHANGED');
   // Avoid a market rollover while the native request is being dispatched.
   const clock=(await this.page.locator('#fuelMain').innerText()).match(/PRICE CHANGE\s+(\d{2}):(\d{2}):(\d{2})/i);
   if(!clock||Number(clock[1])*3600+Number(clock[2])*60+Number(clock[3])<10)throw Error('SUPPLY_PRICE_ROLLOVER');
   const response=this.page.waitForResponse(r=>{
    const u=new URL(r.url());return u.origin==='https://www.airlinemanager.com'&&u.pathname===`/${kind}.php`&&u.searchParams.get('mode')==='do'&&u.searchParams.get('amount')===String(quantity);
   },{timeout:this.timeout}).catch(()=>null);
   // From this point a click may have been delivered. Never retry automatically.
   mutationAttempted=true;
   await button.click({timeout:this.timeout});
   const received=await response;if(!received||!received.ok())throw Error('SUPPLY_OUTCOME_UNKNOWN');
   if(await received.finished())throw Error('SUPPLY_OUTCOME_UNKNOWN');
   await this.open(kind);
   const after=await this.snapshot(kind);
   // Negative CO2 quota holding represents a debt, not occupied storage.
   // Repay the deficit first, then fill capacity. The same exact live
   // post-purchase verification remains mandatory as for positive stock.
   const expected=expectedSupplyStockAfterPurchase(before,kind,quantity);
   if(after.holding!==expected.holding||after.remainingCapacity!==expected.remainingCapacity||
     Math.abs((before.balance-after.balance)-quote.total)>1)throw Error('SUPPLY_OUTCOME_UNKNOWN');
   return after;
  }catch(error){
   if(!mutationAttempted){
    const raw=error instanceof Error?error.message:'SUPPLY_PRE_MUTATION_UNCLASSIFIED';
    const code=/^[A-Z0-9_:-]{1,120}$/.test(raw)?raw:'SUPPLY_PRE_MUTATION_UNCLASSIFIED';
    throw new SupplyPreMutationError(code);
   }
   throw error;
  }
 }
 async close(){await closeReadOnlyPopup(this.page,this.timeout);}
}
