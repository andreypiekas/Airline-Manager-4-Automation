import {test,expect,Page} from '@playwright/test';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {SupplyPort,parseSupplyText,parseSupplyQuote,purchaseCallback} from '../../supplies/port';
import {planPurchase,supplyConfig} from '../../supplies/policy';
import {runSupplies} from '../../supplies/run';
const env={ENABLE_DEMAND_MANAGER:'true',DEMAND_FAIL_SAFE:'true',DEMAND_POOL_SCOPE:'airport-pair',DEMAND_EXECUTION_ACK:'individual-return-legs-v1',GITHUB_ACTIONS:'true',GITHUB_REPOSITORY:'andreypiekas/Airline-Manager-4-Automation',GITHUB_RUN_ID:'123',GITHUB_RUN_ATTEMPT:'1',MAX_FUEL_PRICE:'550',MAX_CO2_PRICE:'120'};
async function fixture(page:Page,variant=''){
 await page.route('**/*',async r=>{
  const u=new URL(r.request().url());
  if(u.searchParams.get('mode')==='do'){await r.fulfill({status:variant==='httpfail'?500:200,body:'ok'});return;}
  await r.fulfill({body:'<html></html>',contentType:'text/html'});
 });
 await page.goto('https://www.airlinemanager.com/synthetic');
 await page.setContent(`<span id="headerAccount">100000</span><div id="smallMainMenu"><div onclick="hideAllWhenClick();popup('fuel.php','Fuel',false,false,true);"><div><span>Fuel</span></div></div></div><div><span id="popTitle" style="display:none">Fuel</span><button onclick="closePop();document.getElementById('rewardPopup').style.display='none';">Close</button></div><div id="rewardPopup"></div><button id="popBtn2"></button><div id="fuelMain" style="display:none"></div><script>
 const variant=${JSON.stringify(variant)};let kind='fuel';window.purchases=0;let amount=1000;let stock={fuel:1000,co2:1000};let cash=100000;
 function price(){return variant==='expensive'?2000:kind==='fuel'?500:100}
 function discount(){return variant==='discount-fuel'&&kind==='fuel'?25:variant==='discount-co2'&&kind==='co2'?10:variant==='overcharge-fuel'&&kind==='fuel'?25:0}
 function totalCost(qty){return Math.round(qty*price()/1000*(1-discount()/100))+(variant==='overcharge-fuel'&&kind==='fuel'?123:0)}
 function priceClock(){return variant==='rollover-co2'&&kind==='co2'?'00:00:05':'00:15:00'}
 function $(s){return {val(){return document.querySelector(s).value},removeClass(){return this},addClass(){return this},hide(){return this}}}
 function playSound(){}function hideAllWhenClick(){}function closePop(){document.querySelector('#popTitle').style.display='none';document.querySelector('#fuelMain').style.display='none'}
 function render(){const unit=kind==='fuel'?'Lbs':'Quotas';const p=document.querySelector('#fuelMain');p.style.display='block';document.querySelector('#popTitle').style.display='block';document.querySelector('#headerAccount').textContent=String(cash);
 p.innerHTML='<div>'+(kind==='fuel'?'Current price':'Quota cost')+'</div><b>$ '+price()+'</b><div>PRICE CHANGE</div><span>'+priceClock()+'</span><div>CAPACITY</div><span>'+(10000-stock[kind])+' / 10000 '+unit+'</span><div>HOLDING</div><span>'+stock[kind]+' '+unit+'</span><div>TOTAL PRICE</div><span id="total">$'+price()+'</span><div>AMOUNT TO PURCHASE</div><input type="tel" id="amountInput" placeholder="Amount to purchase" value="1000"><button id="purchase">Purchase</button><div>'+(kind==='fuel'?'Fuel price per 1,000 Lbs':'Co2 quota cost per 1,000')+'</div>';
 document.querySelector('#total').textContent='$'+totalCost(1000);
 if(discount()){const discountLabel=document.createElement('span');discountLabel.id='discount';discountLabel.textContent='-'+discount()+'%';document.querySelector('#total').after(discountLabel)}
 document.querySelector('#purchase').setAttribute('onclick',variant==='callback'?'window.purchases++':kind==='fuel'?${JSON.stringify(purchaseCallback('fuel'))}:${JSON.stringify(purchaseCallback('co2'))});
 document.querySelector('#amountInput').onkeyup=()=>{document.querySelector('#total').textContent='$'+totalCost(Number(document.querySelector('#amountInput').value))};
 document.querySelector('#popBtn2').setAttribute('onclick',"$('.popMenuBtn').removeClass('active');$(this).addClass('active');$('#detailsAction').hide();Ajax('co2.php','fuelMain',this,false,false);");}
 function popup(){kind='fuel';render()}
 async function Ajax(url){if(url==='co2.php'){kind='co2';render();return}window.purchases++;const qty=Number(new URL(url,location.href).searchParams.get('amount'));if(variant!=='unknown'&&variant!=='httpfail'){stock[kind]+=qty;cash-=totalCost(qty);render()}await fetch('/'+url)}
 </script>`);
}
async function execute(page:Page,dryRun:boolean){const dir=await mkdtemp(join(tmpdir(),'am4-supply-'));return {dir,run:()=>runSupplies(page,dryRun,env,dir,new SupplyPort(page,800))};}
test('dry run quotes both supplies without a purchase',async({page})=>{await fixture(page);const {dir,run}=await execute(page,true);try{const r=await run();expect(r.entries.map(e=>e.status)).toEqual(['would_buy','would_buy']);expect(await page.evaluate(()=>(window as any).purchases)).toBe(0);}finally{await rm(dir,{recursive:true,force:true})}});
test('production confirms both stocks and payments, rejects duplicate execution',async({page})=>{await fixture(page);const {dir,run}=await execute(page,false);try{const r=await run();expect(r.entries.map(e=>e.status)).toEqual(['purchased','purchased']);expect(r.entries[1].before.balance).toBe(95500);await expect(run()).rejects.toThrow();expect(await page.evaluate(()=>(window as any).purchases)).toBe(2);}finally{await rm(dir,{recursive:true,force:true})}});
test('pre-click CO2 price rollover is a safe skip and never becomes an uncertain purchase',async({page})=>{
 await fixture(page,'rollover-co2');
 const {dir,run}=await execute(page,false);
 try{
  const report=await run();
  expect(report.halted).toBe(false);
  expect(report.entries[0]).toMatchObject({kind:'fuel',status:'purchased',reason:'STOCK_AND_PAYMENT_CONFIRMED'});
  expect(report.entries[1]).toMatchObject({kind:'co2',status:'skipped',reason:'PRICE_ROLLOVER_BEFORE_PURCHASE'});
  expect(await page.evaluate(()=>(window as any).purchases)).toBe(1);
  const persisted=JSON.parse(await readFile(join(dir,'supply-report.json'),'utf8'));
  expect(persisted.entries[1].status).toBe('skipped');
  expect(persisted.entries[1].reason).toBe('PRICE_ROLLOVER_BEFORE_PURCHASE');
 }finally{await rm(dir,{recursive:true,force:true})}
});


test('real discounted fuel quote reconciles native 25% price and confirms purchase',async({page})=>{
 await fixture(page,'discount-fuel');
 const {dir,run}=await execute(page,false);
 try{
  const report=await run();
  expect(report.halted).toBe(false);
  expect(report.entries.map(e=>e.status)).toEqual(['purchased','purchased']);
  expect(report.entries[0]).toMatchObject({kind:'fuel',discountPercent:25,quotedCost:3375,reason:'STOCK_AND_PAYMENT_CONFIRMED'});
  expect(report.entries[1].before.balance).toBe(96625);
  expect(await page.evaluate(()=>(window as any).purchases)).toBe(2);
 }finally{await rm(dir,{recursive:true,force:true})}
});
test('invalid promotional total is rejected before any purchase',async({page})=>{
 await fixture(page,'overcharge-fuel');
 const {dir,run}=await execute(page,false);
 try{
  await expect(run()).rejects.toThrow('SUPPLY_HALTED');
  const report=JSON.parse(await readFile(join(dir,'supply-report.json'),'utf8'));
  expect(report.entries[0].status).toBe('unavailable');
  expect(await page.evaluate(()=>(window as any).purchases)).toBe(0);
 }finally{await rm(dir,{recursive:true,force:true})}
});
test('live discounted quote parser matches incident and rejects unsupported math',()=>{
 expect(parseSupplyQuote('TOTAL PRICE\n$3375-25%\nAMOUNT TO PURCHASE',500,9000))
  .toEqual({total:3375,discountPercent:25});
 expect(parseSupplyQuote('TOTAL PRICE\n$4,487,653\n-25%\nAMOUNT TO PURCHASE',480,12465703))
  .toEqual({total:4487653,discountPercent:25});
 expect(parseSupplyQuote('TOTAL PRICE\n$5,983,537\nAMOUNT TO PURCHASE',480,12465703))
  .toEqual({total:5983537,discountPercent:0});
 expect(()=>parseSupplyQuote('TOTAL PRICE\n$4,487,653\nAMOUNT TO PURCHASE',480,12465703))
  .toThrow('SUPPLY_QUOTE_INCONSISTENT');
 expect(()=>parseSupplyQuote('TOTAL PRICE\n$4,487,653\n-100%\nAMOUNT TO PURCHASE',480,12465703))
  .toThrow('SUPPLY_QUOTE_UNVERIFIED');
});

test('above-cap prices never touch purchase controls',async({page})=>{await fixture(page,'expensive');const {dir,run}=await execute(page,false);try{const r=await run();expect(r.entries.map(e=>e.reason)).toEqual(['PRICE_ABOVE_LIMIT','PRICE_ABOVE_LIMIT']);expect(await page.evaluate(()=>(window as any).purchases)).toBe(0);}finally{await rm(dir,{recursive:true,force:true})}});
for(const variant of ['callback','unknown','httpfail'])test(`blocks unverified or uncertain purchase: ${variant}`,async({page})=>{await fixture(page,variant);const {dir,run}=await execute(page,false);try{await expect(run()).rejects.toThrow('SUPPLY_HALTED');const r=JSON.parse(await readFile(join(dir,'supply-report.json'),'utf8'));expect(r.halted).toBe(true);expect(r.entries).toHaveLength(1);expect(await page.evaluate(()=>(window as any).purchases)).toBe(variant==='callback'?0:1);}finally{await rm(dir,{recursive:true,force:true})}});
test('CO2 parser accepts bounded explanatory text without guessing duplicate sections',()=>{
 const text='QUOTA COST\nMarket status stable\n$ 100\nNext update soon\nPRICE CHANGE\nCAPACITY\nStorage available\n900 / 1000 Quotas\nHOLDING\nCurrent stock\n100 Quotas';
 expect(parseSupplyText(text,'co2',5000)).toEqual({pricePer1000:100,holding:100,remainingCapacity:900,balance:5000});
 expect(()=>parseSupplyText(text+'\nQUOTA COST\n$ 100\nPRICE CHANGE','co2',5000)).toThrow('SUPPLY_DATA_UNVERIFIED');
});
test('CO2 parser accepts observed negative holding only when it does not consume storage',()=>{
 const text='QUOTA COST\n$ 160\nPRICE CHANGE\n00:17:37\nCAPACITY\n4,820,500 / 4,820,500 Quotas\nHOLDING\n-3,226,210 Quotas';
 expect(parseSupplyText(text,'co2',14737661)).toEqual({pricePer1000:160,holding:-3226210,remainingCapacity:4820500,balance:14737661});
 expect(()=>parseSupplyText(text.replace('4,820,500 / 4,820,500','4,000,000 / 4,820,500'),'co2',14737661)).toThrow('SUPPLY_CAPACITY_INCONSISTENT');
});

test('supply diagnostic is read-only and excludes account balance',async({page})=>{
 await fixture(page);
 const port=new SupplyPort(page,500);
 await port.open('fuel');
 const d=await port.diagnostic('fuel');
 expect(d?.kind).toBe('fuel');
 expect(JSON.stringify(d)).toContain('Current price');
 expect(JSON.stringify(d)).not.toContain('100000');
 expect(await page.evaluate(()=>(window as any).purchases)).toBe(0);
});

test('pre-mutation supply failure persists passive diagnostic',async({page})=>{
 await fixture(page);
 await page.locator('#smallMainMenu').evaluate((menu)=>{
   const original=(window as any).popup;
   (window as any).popup=()=>{original();};
 });
 const dir=await mkdtemp(join(tmpdir(),'am4-supply-'));
 try{
   class DiagnosticPort extends SupplyPort{
     override async snapshot(kind:any){
       if(kind==='co2')throw Error('SUPPLY_CAPACITY_INCONSISTENT');
       return super.snapshot(kind);
     }
     override async diagnostic(kind:any){return {kind,rows:[{tag:'div',id:null,text:'CAPACITY',value:null,classShape:null}],panelText:['CAPACITY','900 / 1000 Quotas','HOLDING','100 Quotas'],mutationAuthorized:false as const};}
   }
   await expect(runSupplies(page,false,env,dir,new DiagnosticPort(page,500))).rejects.toThrow('SUPPLY_CAPACITY_INCONSISTENT');
   const report=JSON.parse(await readFile(join(dir,'supply-report.json'),'utf8'));
   expect(report.entries.at(-1)?.diagnostic?.panelText).toEqual(['CAPACITY','900 / 1000 Quotas','HOLDING','100 Quotas']);
   expect(report.entries.at(-1)?.status).toBe('unavailable');
 }finally{await rm(dir,{recursive:true,force:true})}
});
test('missing panel and inconsistent storage are rejected',async({page})=>{await fixture(page);await expect(new SupplyPort(page,100).snapshot('fuel')).rejects.toThrow();expect(()=>parseSupplyText('CURRENT PRICE\n$ 500\nPRICE CHANGE\nCAPACITY\n900 / 1000 Lbs\nHOLDING\n200 Lbs','fuel',1000)).toThrow();});
test('negative CO2 holding skips expensive market and blocks cheap purchase until deficit policy is verified',()=>{
 const snapshot={pricePer1000:160,holding:-3226210,remainingCapacity:4820500,balance:14737661};
 const expensive=supplyConfig({...env,MAX_CO2_PRICE:'120'});
 expect(planPurchase(snapshot,'co2',expensive).reason).toBe('PRICE_ABOVE_LIMIT');
 const cheap=supplyConfig({...env,MAX_CO2_PRICE:'200'});
 expect(planPurchase(snapshot,'co2',cheap)).toMatchObject({quantity:0,reason:'CO2_DEFICIT_PURCHASE_POLICY_UNVERIFIED'});
});

test('real Actions reruns rejected before opening the supply menu',async({page})=>{await fixture(page);const dir=await mkdtemp(join(tmpdir(),'am4-supply-'));try{await expect(runSupplies(page,false,{...env,GITHUB_RUN_ATTEMPT:'2'},dir)).rejects.toThrow('RERUN');expect(await page.locator('#fuelMain').isVisible()).toBe(false);}finally{await rm(dir,{recursive:true,force:true})}});
