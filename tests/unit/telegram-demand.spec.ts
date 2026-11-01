import { test, expect } from '@playwright/test';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
const {runSummaryMessage,importantMessage}=require('../../scripts/telegram-demand.cjs');

test('semi-automatic Telegram summary is concise and requires manual execution',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'am4-telegram-'));
 const oldMode=process.env.AUTOMATION_MODE,oldUrl=process.env.WORKFLOW_URL;
 try{
  process.env.AUTOMATION_MODE='semi-automatic';
  process.env.WORKFLOW_URL='https://github.com/example/repo/actions/workflows/playwright.yml';
  await writeFile(join(dir,'semi-automatic-summary.json'),JSON.stringify({
   mode:'semi-automatic',
   fleet:{seen:20,ready:13,inflight:7},
   demand:{evaluated:13,sufficient:11,insufficient:2,unavailable:0},
   pricing:{wouldAdjust:4,recommendationOnly:1,unchanged:8,unavailable:0},
   routes:{wouldReroute:2,keep:6,hold:5,unavailable:0},
   supplies:{fuel:{pricePer1000:420,status:'would_buy'},co2:{pricePer1000:88,status:'would_buy'}}
  }));
  const text=runSummaryMessage(dir,'success');
  expect(text).toContain('MODO SEMIAUTOMÁTICO');
  expect(text).toContain('Prontas: 13');
  expect(text).toContain('Fuel: $420/1k');
  expect(text).toContain('Pricing: 4 ajustes sugeridos');
  expect(text).toContain('Nenhuma operação foi executada');
  expect(text).toContain('confirm_semiautomatic_execution');
 }finally{
  if(oldMode===undefined)delete process.env.AUTOMATION_MODE;else process.env.AUTOMATION_MODE=oldMode;
  if(oldUrl===undefined)delete process.env.WORKFLOW_URL;else process.env.WORKFLOW_URL=oldUrl;
  await rm(dir,{recursive:true,force:true});
 }
});

test('safe maintenance HOLD becomes an explicit Telegram alert without implying mutation',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'am4-telegram-maint-hold-'));
 try{
  await writeFile(join(dir,'operational-modules.json'),JSON.stringify({
   schemaVersion:1,
   maintenance:{status:'held_safe',evidence:{reason:'UI_CONTROL_OBSCURED',mutationAuthorized:false}}
  }));
  const text=importantMessage(dir,'success',join(dir,'missing-journal.json'));
  expect(text).toContain('manutencao em HOLD seguro: UI_CONTROL_OBSCURED');
  expect(text).not.toContain('executada');
 }finally{await rm(dir,{recursive:true,force:true});}
});

test('campaign verification is shown in Telegram summary and blocks departures when unverified',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'am4-telegram-campaign-'));
 const oldRun=process.env.GITHUB_RUN_NUMBER;
 try{
  process.env.GITHUB_RUN_NUMBER='99';
  await writeFile(join(dir,'company-dashboard.json'),JSON.stringify({
   run:{stale:false},
   bases:{effective:['AAA'],status:'observed'},
   fleet:{seen:2,inflight:1,ready:1},
   demand:{sufficient:1,evaluated:1,insufficient:0,unavailable:0},
   departures:{departed:0,evaluated:1,held:1,unknown:0},
   pricing:{adjusted:0,unchanged:1,unknown:0},
   routes:{rerouted:0,reviewDecisions:{keep:0,hold:0,wouldReroute:0}},
   supplies:{},
   campaign:{
    status:'unverified',
    departureAuthorized:false,
    evidence:{
     allRequiredVerified:false,
     ecoFriendly:{required:true,verifiedActive:false},
     airlineReputation:{required:true,verifiedActive:true}
    }
   },
   quarantines:{departure:0,route:0,pricingRoute:0,supplyKinds:0},
   uiHealth:{status:'healthy'}
  }));
  await writeFile(join(dir,'operational-modules.json'),JSON.stringify({
   schemaVersion:1,
   campaign:{status:'unverified',evidence:{allRequiredVerified:false,departureAuthorized:false}}
  }));
  const summary=runSummaryMessage(dir,'success');
  expect(summary).toContain('Campanhas: Eco ❌ | Reputation ✅ | decolagens ⛔');
  const alert=importantMessage(dir,'success',join(dir,'missing-journal.json'));
  expect(alert).toContain('campanhas exigidas nao confirmadas; decolagens bloqueadas');
 }finally{
  if(oldRun===undefined)delete process.env.GITHUB_RUN_NUMBER;else process.env.GITHUB_RUN_NUMBER=oldRun;
  await rm(dir,{recursive:true,force:true});
 }
});

test('post-reroute pricing HOLD becomes an explicit Telegram alert',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'am4-telegram-reroute-pricing-'));
 try{
  await writeFile(join(dir,'execution-report.json'),JSON.stringify({
   entries:[{aircraftId:'101',status:'held',reason:'REROUTE_PRICING_NOT_VERIFIED'}]
  }));
  const text=importantMessage(dir,'success',join(dir,'missing-journal.json'));
  expect(text).toContain('aeronaves reroteadas aguardando pricing confirmado: 1');
 }finally{await rm(dir,{recursive:true,force:true});}
});

test('challenge evidence becomes an explicit Telegram alert',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'am4-telegram-challenge-'));
 try{
  await writeFile(join(dir,'challenge-detected.json'),JSON.stringify({detected:true,reason:'VISIBLE_CHALLENGE_CONTROL_DETECTED'}));
  expect(importantMessage(dir,'failure',join(dir,'missing-journal.json'))).toContain('CAPTCHA/challenge detectado');
 }finally{await rm(dir,{recursive:true,force:true});}
});


test('Telegram identifies separate aircraft sharing the same directional route',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'am4-telegram-shared-routes-'));
 const {sharedRouteMessage}=require('../../scripts/telegram-demand.cjs');
 try{
  await writeFile(join(dir,'demand-report.json'),JSON.stringify({
   collectionComplete:true,
   decisions:[
    {aircraftId:'101',routeId:'201',registration:'XP-101',from:'GRU',to:'BSB'},
    {aircraftId:'102',routeId:'202',registration:'XP-102',from:'GRU',to:'BSB'},
    {aircraftId:'103',routeId:'203',registration:'XP-103',from:'BSB',to:'GRU'},
    {aircraftId:'104',routeId:'204',registration:'XP-104',from:'GRU',to:'GIG'}
   ]
  }));
  const summary=sharedRouteMessage(dir);
  expect(summary).toContain('GRU→BSB: XP-101, XP-102');
  expect(summary).not.toContain('XP-103');
  expect(summary).not.toContain('XP-104');
 }finally{await rm(dir,{recursive:true,force:true});}
});

test('a duplicated rendered route identity is never reported as an extra aircraft',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'am4-telegram-id-repeated-'));
 const {sharedRouteMessage}=require('../../scripts/telegram-demand.cjs');
 try{
  await writeFile(join(dir,'demand-report.json'),JSON.stringify({collectionComplete:false,decisions:[
   {aircraftId:'101',routeId:'201',registration:'XP-101',from:'GRU',to:'BSB'},
   {aircraftId:'101',routeId:'201',registration:'XP-101',from:'GRU',to:'BSB'},
   {aircraftId:'102',routeId:'202',registration:'XP-102',from:'GRU',to:'BSB'}
  ]}));
  expect(sharedRouteMessage(dir)).toBeNull();
 }finally{await rm(dir,{recursive:true,force:true});}
});

test('Telegram displays total estimated gross revenue only with complete observed fares',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'am4-telegram-revenue-'));
 const {departureValueMessage}=require('../../scripts/telegram-demand.cjs');
 try{
  const entries=[
   {status:'departed',estimatedGrossTicketRevenue:12000},
   {status:'departed',estimatedGrossTicketRevenue:8500},
   {status:'held',estimatedGrossTicketRevenue:999999}
  ];
  await writeFile(join(dir,'execution-report.json'),JSON.stringify({dryRun:false,summary:{departed:2},entries}));
  expect(departureValueMessage(dir)).toContain('$20,500 (2 confirmadas');
  entries[1].estimatedGrossTicketRevenue=null as unknown as number;
  await writeFile(join(dir,'execution-report.json'),JSON.stringify({dryRun:false,summary:{departed:2},entries}));
  expect(departureValueMessage(dir)).toContain('n/d (tarifa verificada em 1/2)');
  await writeFile(join(dir,'execution-report.json'),JSON.stringify({dryRun:true,summary:{departed:2},entries}));
  expect(departureValueMessage(dir)).toContain('n/d');
 }finally{await rm(dir,{recursive:true,force:true});}
});

test('Telegram summary includes both shared planes and the gross value',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'am4-telegram-totals-'));
 try{
  await writeFile(join(dir,'company-dashboard.json'),JSON.stringify({
   fleet:{seen:2,ready:2,inflight:0},demand:{sufficient:2,evaluated:2,insufficient:0,unavailable:0},
   departures:{departed:2,evaluated:2,held:0,unknown:0}
  }));
  await writeFile(join(dir,'demand-report.json'),JSON.stringify({collectionComplete:true,decisions:[
   {aircraftId:'1',routeId:'11',registration:'T-1',from:'GRU',to:'BSB'},
   {aircraftId:'2',routeId:'12',registration:'T-2',from:'GRU',to:'BSB'}
  ]}));
  await writeFile(join(dir,'execution-report.json'),JSON.stringify({dryRun:false,summary:{departed:2},entries:[
   {status:'departed',estimatedGrossTicketRevenue:500},
   {status:'departed',estimatedGrossTicketRevenue:1200}
  ]}));
  const summary=runSummaryMessage(dir,'success');
  expect(summary).toContain('Rotas compartilhadas: GRU→BSB: T-1, T-2');
  expect(summary).toContain('Receita bruta estimada das decolagens: $1,700');
 }finally{await rm(dir,{recursive:true,force:true});}
});


test('Telegram production summary separates confirmed departures from partial fleet coverage',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'am4-telegram-executive-'));
 const oldRun=process.env.GITHUB_RUN_NUMBER;
 try{
  process.env.GITHUB_RUN_NUMBER='1329';
  await writeFile(join(dir,'company-dashboard.json'),JSON.stringify({
   run:{stale:false},
   fleet:{scope:'FIRST_PAGE_ONLY',collectionComplete:false,seen:17,inflight:null,ready:null},
   demand:{evaluated:17,sufficient:15,insufficient:2,unavailable:0},
   departures:{evaluated:17,departed:15,held:2,unknown:0},
   supplies:{fuel:{status:'skipped',pricePer1000:900},co2:{status:'skipped',pricePer1000:200}},
   quarantines:{departure:3,route:0,pricingRoute:0,supplyKinds:0},
   uiHealth:{status:'healthy'}
  }));
  await writeFile(join(dir,'execution-report.json'),JSON.stringify({
   dryRun:false,summary:{departed:15},entries:[
    ...Array.from({length:15},()=>({status:'departed',estimatedGrossTicketRevenue:1000})),
    {status:'held',estimatedGrossTicketRevenue:999999}
   ]
  }));
  const summary=runSummaryMessage(dir,'success');
  expect(summary).toContain('AIRLINE MANAGER 4  •  #1329');
  expect(summary).toContain('SUCESSO  |  COBERTURA PARCIAL');
  expect(summary).toContain('Frota global não auditada');
  expect(summary).toContain('Aeronaves avaliadas nas janelas: 17');
  expect(summary).not.toContain('Frota: 17 | voo n/d');
  expect(summary).toContain('🛫 DECOLAGENS');
  expect(summary).toContain('Decolagens: 15/17 confirmadas | retidas 2 | incertas 0');
  expect(summary).toContain('Receita bruta estimada das decolagens: $15,000');
  expect(summary).toContain('⛽ SUPRIMENTOS');
  expect(summary).toContain('Fuel: não comprado');
  expect(summary).toContain('Segurança: quarentenas D3');
  expect(summary.length).toBeLessThan(3501);
 }finally{
  if(oldRun===undefined)delete process.env.GITHUB_RUN_NUMBER;else process.env.GITHUB_RUN_NUMBER=oldRun;
  await rm(dir,{recursive:true,force:true});
 }
});

test('Telegram does not describe complete verified fleet as partial',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'am4-telegram-full-'));
 try{
  await writeFile(join(dir,'company-dashboard.json'),JSON.stringify({
   fleet:{scope:'GLOBAL_OBSERVED',collectionComplete:true,seen:12,inflight:9,ready:3},
   departures:{evaluated:3,departed:2,held:1,unknown:0}
  }));
  const summary=runSummaryMessage(dir,'success');
  expect(summary).toContain('Frota: 12 | voo 9 | prontas 3');
  expect(summary).not.toContain('COBERTURA PARCIAL');
  expect(summary).toContain('Decolagens: 2/3 confirmadas');
 }finally{await rm(dir,{recursive:true,force:true});}
});
