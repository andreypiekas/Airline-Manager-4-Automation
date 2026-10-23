import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { test, expect, Page } from '@playwright/test';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AircraftSnapshot, CollectionResult, DemandReport } from '../../demand/types';
import { optimizationConfig } from '../../optimization/report';
import { researchConfig, researchFleetCandidates, researchQueueRotation, writeRouteResearchReport } from '../../optimization/research-reader';

const TEST_NOW=new Date(Date.now()+60_000);

function snapshot(): AircraftSnapshot {
  return {aircraftId:'101',registration:'SYNTHETIC',routeId:'1',routeLabel:'AAA-BBB',from:'AAA',to:'BBB',state:'ready',
    capacity:{Y:100,J:0,F:0},remaining:{Y:1000,J:100,F:100},dailyTotal:{Y:1000,J:100,F:100},observedAt:TEST_NOW.toISOString(),
    operational:{rangeKm:3440,minRunwayFt:7550,flightHours:682,cycles:206,homeBase:null,flightId:null}};
}
const settings = optimizationConfig({AIRLINE_BASES_JSON:'["AAA"]'});
const config = {...researchConfig({ENABLE_ROUTE_RESEARCH:'true'}),timeout:300};
function collection(a = snapshot()): CollectionResult {return {aircraft:[a],complete:true,expectedRoutes:1,warnings:[]};}

function insufficientDemand(a=snapshot(),occupancyPercentage=10):DemandReport{
  return {
    schemaVersion:1,generatedAt:TEST_NOW.toISOString(),dryRun:true,
    config:{enabled:true,dryRun:true,failSafe:true,minPercentage:80,mode:'aggregate',poolScope:'airport-pair',maxAgeSeconds:300},
    collectionComplete:true,warnings:[],
    summary:{fleetSeen:1,evaluated:1,sufficient:0,insufficient:1,unavailable:0,notReady:0},
    decisions:[{
      ...a,poolKey:[a.from,a.to].sort().join(':'),decision:'hold_insufficient',reason:'synthetic insufficient demand',
      availableBefore:{Y:10,J:0,F:0},possiblePassengers:{Y:10,J:0,F:0},occupancyPercentage,
      classOccupancy:{Y:occupancyPercentage,J:null,F:null},requiredPassengers:80,requiredByClass:{Y:80,J:0,F:0},
      thresholdPercentage:80,thresholdSource:'configured-floor',departureAuthorized:false
    }]
  };
}

async function fixture(page:Page, options: Record<string,boolean> = {}) {
  await page.route('**/*',r=>r.abort());
  await page.setContent(`<button>Routes (${options.secondPage?2:1})</button><div id="mapRoutes" onclick="hideAllWhenClick();menuFleet('Routes');">Fleet</div><div id="routeAction"><div id="routesContainer"></div></div><div id="detailsAction" style="display:none"></div><div id="flightInfoContainer" style="display:none"></div><div id="newRouteInfo" style="display:none"></div><script>
  const options=${JSON.stringify(options)}; const intro=0;window.mutations=0;window.researches=0;window.resets=0;
  function playSound(){} function closePop(){document.querySelector('#routeAction').style.display='none';document.querySelector('#detailsAction').style.display='none'}
  function hideAllWhenClick(){}
  function $(s){return {hide(){document.querySelector(s).style.display='none'},removeClass(){},addClass(){}}}
  function menuFleet(){if(options.toggle&&document.querySelector('#routeAction').style.display!=='none'){closePop();return}resetList()}
  function resetList(){window.resets++;if(options.restoreFailure&&window.resets>1)return;document.querySelector('#routeAction').innerHTML='<div id="routesContainer"></div>';document.querySelector('#routeAction').style.display='block';document.querySelector('#detailsAction').style.display='none';document.querySelector('#flightInfoContainer').style.display='none';document.querySelector('#newRouteInfo').style.display='none';render(0)}
  function render(index){document.querySelector('#routesContainer').innerHTML=index===0&&options.secondPage?\`<div id="routeMainList2">Other</div><ul class="pagination"><a href="#" onclick="Ajax('routes.php?start=20&sort=','routeAction',this);">Next</a></ul>\`:\`<div class="classPAX listDepartable" id="routeMainList1"><a href="#" onclick="playSound('neutral_click');Ajax('fleet_details.php?id=101','detailsAction');if(intro==0) {$('#routeAction').hide();}"><span id="acRegList101">SYNTHETIC</span> - Test aircraft</a><button id="listDepart1" onclick="window.mutations++">Depart</button></div>\`;
  if(options.badPagination&&index===0&&options.secondPage)document.querySelector('.pagination a').setAttribute('onclick','window.mutations++');
  if(options.badDetails&&!options.secondPage)document.querySelector('#routeMainList1 a').setAttribute('onclick','window.mutations++');}
  function Ajax(url){if(url==='routes.php'){resetList();return}if(url.startsWith('routes.php')){if(!options.loop)render(1);return}if(url.startsWith('fleet_details.php')){details();return}
  if(url.startsWith('add_airports.php')){document.querySelector('#flightInfoContainer').insertAdjacentHTML('beforeend',\`<button id="introSuggestm" onclick="playSound('neutral_click');Ajax('new_route_info.php?id=101&airportId=200&ferry=0','newRouteInfo',this,false,true);">Next</button>\`);return}
  if(url.startsWith('new_route_info.php'))quote();}
  function details(){const d=document.querySelector('#detailsAction');d.style.display='block';d.innerHTML=\`<span id="ff-name">SYNTHETIC</span><button id="routeViewDepart" onclick="window.mutations++;/* route_depart.php?id=1&ref=list */">Depart</button><button id="routeViewGround_unground" onclick="window.mutations++">Ground</button><div class="col-5"><span class="l-text">AAA</span></div><div class="col-5"><span class="l-text">BBB</span></div><div id="seat-layout">\`+['economy','business','first'].map((c,i)=>'<div><img src="assets/'+c+'_seat.png">'+(i?0:100)+'</div>').join('')+\`</div><div id="list-demand">\`+['economy','business','first'].map((c,i)=>'<div><img src="assets/'+c+'_seat.png">'+(i?'100/100':'1000/1000')+'</div>').join('')+\`</div><span class="s-text">Range</span><br><span class="m-text">3,440km</span><br><span class="s-text">Min runway</span><br><span class="m-text">7,550ft</span><br><span class="s-text">Flight hours/Cycles</span><br><span class="m-text">682 / 206</span><button id="reroute" onclick="showFlightInfo(this,101,8,false,true);closePop();">Reroute</button>\`;
  if(options.contextChanged)d.querySelector('.l-text').textContent='BBB';if(options.badPlanner)d.querySelector('#reroute').setAttribute('onclick','window.mutations++');}
  function showFlightInfo(){window.researches++;const p=document.querySelector('#flightInfoContainer');p.style.display='block';p.innerHTML=\`<button id="introSuggest" onclick="playSound('neutral_click');Ajax('add_airports.php?mode=suggest&id=101','runme',this,false,true);">Suggest route</button>\`;if(options.loadFailure)p.innerHTML='Loading';}
  function quote(){const q=document.querySelector('#newRouteInfo');q.style.display='block';q.innerHTML=\`<div class="blue-bg">SYNTHETIC<div>Close</div></div><div class="row p-0"><div class="col-3 m-text"><b>AAA</b></div><div class="col-2"><span class="s-text">1000</span> km</div><div class="col-3 m-text"><b>CCC</b></div></div><table><tr><td>Daily pax demand</td></tr><tr>\`+['economy','business','first'].map(c=>'<td><img src="assets/'+c+'_seat.png"></td>').join('')+\`</tr><tr><td>1000</td><td>100</td><td>100</td></tr></table><div>A/C on route</div><div>0</div><span id="departFlightTimeInfo">02:00:00</span><span id="departFuelInfo">1000</span><span id="departCo2Info">0.14</span><span id="costIndexBar">200</span><div><b>Route fee</b></div><div>$1000</div><button id="introAuto" onclick="window.mutations++">Autoprice</button><button id="btnCreateNewRoute" onclick="window.mutations++">Create route</button><button id="back">Back</button>\`;q.querySelector('#back').setAttribute('onclick',"$('#newRouteInfo').hide('fast');playSound('neutral_click');");}
  render(0);
  if(options.toggle){const button=document.createElement('button');button.id='popBtn1';button.textContent='Fleet';button.setAttribute('onclick',"$('.popMenuBtn').removeClass('active');$(this).addClass('active');$('#detailsAction').hide();Ajax('routes.php','routeAction',this,false,false);");document.querySelector('#routeAction').prepend(button);}
  </script>`);
}

test('queries eligible aircraft, including second page, and restores a fresh list without mutations',async({page},testInfo)=>{
  await fixture(page,{secondPage:true});
  const report=await researchFleetCandidates(page,collection(),settings,{...config,maxSuggestions:1},TEST_NOW);
  expect(report).toMatchObject({uiRestored:true,candidatesComplete:false,comparisonReady:false,mutationAuthorized:false});
  expect(report.aircraft[0]).toMatchObject({status:'observed',result:{quotes:[{from:'AAA',to:'CCC',remainingDemand:null,comparisonReady:false}]}});
  expect(await page.locator('#routeMainList2').isVisible()).toBe(true);
  expect(await page.evaluate(()=>(window as any).mutations)).toBe(0);
  await writeRouteResearchReport(report,testInfo.outputPath('research'));
  await writeFile(testInfo.outputPath('simulation-report.json'),JSON.stringify(report,null,2)+'\n');
});

for(const variant of ['disabled','inflight','incomplete','duplicate','stale'])test(`skips research without any navigation: ${variant}`,async({page})=>{
  await fixture(page);const a=snapshot();const data=collection(a);
  if(variant==='away'){a.from='BBB';a.to='AAA'}if(variant==='inflight')a.state='inflight';if(variant==='incomplete')data.complete=false;
  if(variant==='duplicate')data.aircraft.push({...a});if(variant==='stale')a.observedAt='2000-01-01T00:00:00Z';
  const r=await researchFleetCandidates(page,data,settings,{...config,enabled:variant!=='disabled'},TEST_NOW);
  expect(r.aircraft.every(a=>a.status!=='queued')).toBe(true);expect(await page.evaluate(()=>(window as any).resets)).toBe(0);
  expect(await page.evaluate(()=>(window as any).mutations)).toBe(0);
});
test('away-from-base aircraft may run only the passive diagnostic probe and never mutate',async({page})=>{
  await fixture(page);
  const a=snapshot();a.from='BBB';a.to='AAA';
  const r=await researchFleetCandidates(page,collection(a),settings,{...config,maxSuggestions:1},TEST_NOW);
  expect(r.aircraft[0].status).toBe('pending_base_return');
  expect(r.diagnosticProbe).toBeNull();
  expect(r.warnings).toContain('DIAGNOSTIC_ROUTE_CONTROL_UNAVAILABLE:101');
  expect(await page.evaluate(()=>(window as any).resets)).toBeGreaterThan(0);
  expect(await page.evaluate(()=>(window as any).mutations)).toBe(0);
});

for(const option of ['badDetails','badPlanner','contextChanged','loadFailure','badPagination','loop'])test(`failure blocks research and restores the list: ${option}`,async({page})=>{
  await fixture(page,{[option]:true,secondPage:option==='badPagination'||option==='loop'});
  const r=await researchFleetCandidates(page,collection(),settings,{...config,maxSuggestions:1},TEST_NOW);
  expect(r.aircraft[0].status).toBe('unavailable');expect(r.uiRestored).toBe(true);
  expect(await page.evaluate(()=>(window as any).mutations)).toBe(0);
});
test('restoration failure stops the remaining research queue',async({page})=>{
  await fixture(page,{restoreFailure:true});const a=snapshot();const data=collection(a);data.aircraft.push({...a,aircraftId:'102',routeId:'2'});
  const r=await researchFleetCandidates(page,data,settings,{...config,maxSuggestions:1},TEST_NOW);
  expect(r.uiRestored).toBe(false);expect(r.warnings).toContain('RESEARCH_LIST_RESTORE_FAILED');
  expect(r.aircraft.filter(a=>a.status==='deferred_restore_failure')).toHaveLength(1);
  expect(await page.evaluate(()=>(window as any).mutations)).toBe(0);
});
test('bounded research defers extra aircraft and validates settings before clicking',async({page})=>{
  await fixture(page);const data=collection();data.aircraft.push({...snapshot(),aircraftId:'102',routeId:'2'});
  const r=await researchFleetCandidates(page,data,settings,{...config,maxAircraft:1,maxSuggestions:1},TEST_NOW);
  expect(r.aircraft.filter(a=>a.status==='deferred_limit')).toHaveLength(1);
  for(const env of [{ENABLE_ROUTE_RESEARCH:'yes'},{ROUTE_RESEARCH_MAX_AIRCRAFT:'0'},{ROUTE_RESEARCH_MAX_SUGGESTIONS:'11'}])expect(()=>researchConfig(env)).toThrow('RESEARCH_CONFIG_INVALID');
  await expect(researchFleetCandidates(page,data,settings,{...config,maxAircraft:0},TEST_NOW)).rejects.toThrow('RESEARCH_CONFIG_INVALID');
});

test('uses the inspected Fleet tab when the main menu would toggle the open popup closed',async({page})=>{
  await fixture(page,{toggle:true});const r=await researchFleetCandidates(page,collection(),settings,{...config,maxSuggestions:1},TEST_NOW);
  expect(r.aircraft[0].status).toBe('observed');expect(r.uiRestored).toBe(true);expect(await page.evaluate(()=>(window as any).mutations)).toBe(0);
});


test('completed daily review is skipped before consuming the bounded research slot',async({page})=>{
  await fixture(page);
  const dir=await mkdtemp(join(tmpdir(),'am4-research-journal-'));
  try{
    const now=TEST_NOW;
    await writeFile(join(dir,'return-journal.json'),JSON.stringify({
      schemaVersion:1,scope:'test-scope',entries:[{
        aircraftId:'101',origin:'AAA',flightId:'daily_test',reviewedAt:now.toISOString(),decision:'keep_route'
      }]
    })+'\n');
    const withJournal={...settings,returnJournal:{directory:dir,scope:'test-scope'}};
    const r=await researchFleetCandidates(page,collection(),withJournal,{...config,maxAircraft:1,maxSuggestions:1},TEST_NOW);
    expect(r.aircraft[0]).toMatchObject({aircraftId:'101',status:'completed_today'});
    expect(r.warnings).not.toContain('RESEARCH_JOURNAL_UNAVAILABLE');
    expect(await page.evaluate(()=>(window as any).resets)).toBe(0);
    expect(await page.evaluate(()=>(window as any).researches)).toBe(0);
    expect(await page.evaluate(()=>(window as any).mutations)).toBe(0);
  }finally{await rm(dir,{recursive:true,force:true});}
});


test('insufficient demand reopens route research even after the daily review was already completed',async({page})=>{
  await fixture(page);
  const dir=await mkdtemp(join(tmpdir(),'am4-research-demand-trigger-'));
  try{
    await writeFile(join(dir,'return-journal.json'),JSON.stringify({
      schemaVersion:1,scope:'test-scope',entries:[{
        aircraftId:'101',origin:'AAA',flightId:'daily_test',reviewedAt:TEST_NOW.toISOString(),decision:'keep_route'
      }]
    })+'\n');
    const withJournal={...settings,returnJournal:{directory:dir,scope:'test-scope'}};
    const r=await researchFleetCandidates(
      page,collection(),withJournal,{...config,maxAircraft:1,maxSuggestions:1},TEST_NOW,insufficientDemand()
    );
    expect(r.aircraft[0]).toMatchObject({
      aircraftId:'101',status:'observed',trigger:'demand_insufficient',researchOrigin:'AAA',demandOccupancyPercentage:10
    });
    expect(r.queueRotation).toMatchObject({demandTriggeredEligible:1,scheduledEligible:0});
    expect(await page.evaluate(()=>(window as any).researches)).toBe(1);
    expect(await page.evaluate(()=>(window as any).mutations)).toBe(0);
  }finally{await rm(dir,{recursive:true,force:true});}
});

test('insufficient-demand aircraft has priority over the scheduled research queue',async({page})=>{
  await fixture(page);
  const a=snapshot(),b={...snapshot(),aircraftId:'102',routeId:'2',registration:'SYNTHETIC-2'};
  const data:CollectionResult={aircraft:[a,b],complete:true,expectedRoutes:2,warnings:[]};
  const demand=insufficientDemand(a,0);
  const r=await researchFleetCandidates(page,data,settings,{...config,maxAircraft:1,maxSuggestions:1},TEST_NOW,demand);
  expect(r.aircraft.find(x=>x.aircraftId==='101')).toMatchObject({trigger:'demand_insufficient',status:'observed'});
  expect(r.aircraft.find(x=>x.aircraftId==='102')?.status).toBe('deferred_limit');
  expect(await page.evaluate(()=>(window as any).researches)).toBe(1);
  expect(await page.evaluate(()=>(window as any).mutations)).toBe(0);
});

test('insufficient demand may research safely from the current airport even away from the operational hub',async({page})=>{
  await fixture(page);
  await page.evaluate(()=>{
    const originalDetails=(window as any).details;
    (window as any).details=()=>{
      originalDetails();
      const codes=document.querySelectorAll('#detailsAction .col-5 .l-text');
      if(codes.length===2){codes[0].textContent='BBB';codes[1].textContent='AAA';}
    };
    const originalQuote=(window as any).quote;
    (window as any).quote=()=>{
      originalQuote();
      const codes=document.querySelectorAll('#newRouteInfo .col-3.m-text > b');
      if(codes.length===2)codes[0].textContent='BBB';
    };
  });
  const a={...snapshot(),from:'BBB',to:'AAA',routeLabel:'BBB-AAA'};
  const demand=insufficientDemand(a,5);
  const r=await researchFleetCandidates(page,collection(a),settings,{...config,maxAircraft:1,maxSuggestions:1},TEST_NOW,demand);
  expect(r.aircraft[0]).toMatchObject({
    trigger:'demand_insufficient',researchOrigin:'BBB',status:'observed'
  });
  expect(r.aircraft[0].result?.quotes[0]).toMatchObject({from:'BBB',to:'CCC'});
  expect(await page.evaluate(()=>(window as any).mutations)).toBe(0);
});

test('unavailable persistent review journal fails route research closed before navigation',async({page})=>{
  await fixture(page);
  const dir=await mkdtemp(join(tmpdir(),'am4-research-journal-missing-'));
  try{
    const withJournal={...settings,returnJournal:{directory:dir,scope:'test-scope'}};
    const r=await researchFleetCandidates(page,collection(),withJournal,{...config,maxAircraft:1,maxSuggestions:1},TEST_NOW);
    expect(r.aircraft[0]).toMatchObject({aircraftId:'101',status:'journal_unavailable'});
    expect(r.warnings).toContain('RESEARCH_JOURNAL_UNAVAILABLE');
    expect(await page.evaluate(()=>(window as any).resets)).toBe(0);
    expect(await page.evaluate(()=>(window as any).mutations)).toBe(0);
  }finally{await rm(dir,{recursive:true,force:true});}
});


test('confirmed return after same-day review re-enters bounded route research',async({page})=>{
 await fixture(page);
 const dir=await mkdtemp(join(tmpdir(),'am4-research-return-'));
 try{
  const now=TEST_NOW,daily=new Date(now.getTime()-60*60*1000).toISOString();
  const departed=new Date(now.getTime()-30*60*1000).toISOString(),arrived=new Date(now.getTime()-10*60*1000).toISOString();
  const departure={eventId:'dep_return_101',type:'departure',aircraftId:'101',registration:'SYNTHETIC',routeId:'1',from:'BBB',to:'AAA',
   observedAt:departed,result:'departed',demand:{availableBefore:{Y:100,J:0,F:0},possiblePassengers:{Y:100,J:0,F:0},occupancyPercentage:100},
   actualOnboard:{Y:100,J:0,F:0}};
  const arrival={eventId:'arr_dep_return_101',type:'arrival-observed',departureEventId:'dep_return_101',aircraftId:'101',
   registration:'SYNTHETIC',routeId:'1',from:'BBB',to:'AAA',departedAt:departed,observedAt:arrived,result:'arrived_observed'};
  await writeFile(join(dir,'return-journal.json'),JSON.stringify({schemaVersion:1,scope:'test-scope',
   entries:[{aircraftId:'101',origin:'AAA',flightId:'daily_old',reviewedAt:daily,decision:'keep_route'}],
   events:[departure,arrival]})+'\n');
  const withJournal={...settings,returnJournal:{directory:dir,scope:'test-scope'}};
  const r=await researchFleetCandidates(page,collection(),withJournal,{...config,maxAircraft:1,maxSuggestions:1},TEST_NOW);
  expect(r.aircraft[0]).toMatchObject({aircraftId:'101',status:'observed'});
  expect(await page.evaluate(()=>(window as any).researches)).toBe(1);
  expect(await page.evaluate(()=>(window as any).mutations)).toBe(0);
 }finally{await rm(dir,{recursive:true,force:true});}
});


test('retryable route research queue rotates fairly across half-hour windows',()=>{
 const items=['A','B','C','D'];
 const first=researchQueueRotation(items,new Date('2026-10-04T05:00:00Z'));
 const next=researchQueueRotation(items,new Date('2026-10-04T05:30:00Z'));
 expect(first.entries).toHaveLength(4);expect(next.entries).toHaveLength(4);
 expect(new Set(first.entries)).toEqual(new Set(items));expect(new Set(next.entries)).toEqual(new Set(items));
 expect(next.offset).toBe((first.offset+1)%items.length);
 expect(next.entries[0]).not.toBe(first.entries[0]);
});

test('scheduled batch rotation inspects distinct sets and covers a 126-aircraft fleet',()=>{
  const fleet=Array.from({length:126},(_,i)=>String(i+1));
  const epoch=Date.parse('2026-10-04T05:00:00Z');
  const inspected=new Set<string>();
  let previous=new Set<string>();
  for(let i=0;i<42;i++){
    const slot=researchQueueRotation(fleet,new Date(epoch+i*30*60000),30,3);
    expect(slot.stride).toBe(3);
    const batch=slot.entries.slice(0,3);
    expect(new Set(batch).size).toBe(3);
    expect(batch.some(x=>previous.has(x))).toBe(false);
    batch.forEach(x=>inspected.add(x));
    previous=new Set(batch);
  }
  expect(inspected.size).toBe(126);
});

test('batch stride matches remaining scheduled capacity after urgent demand work',()=>{
  const fleet=Array.from({length:12},(_,i)=>String(i+1));
  const start=new Date('2026-10-04T05:00:00Z');
  const next=new Date(start.getTime()+30*60000);
  const a=researchQueueRotation(fleet,start,30,2);
  const b=researchQueueRotation(fleet,next,30,2);
  expect(b.offset).toBe((a.offset+2)%fleet.length);
  expect(a.entries.slice(0,2).some(x=>b.entries.slice(0,2).includes(x))).toBe(false);
  expect(()=>researchQueueRotation(fleet,next,30,0)).toThrow('RESEARCH_QUEUE_ROTATION_INVALID');
  expect(()=>researchQueueRotation(fleet,next,30,11)).toThrow('RESEARCH_QUEUE_ROTATION_INVALID');
});

test('route research queue rotation validates its time window without navigation',()=>{
 expect(()=>researchQueueRotation([1],new Date('invalid'))).toThrow('RESEARCH_QUEUE_ROTATION_INVALID');
 expect(()=>researchQueueRotation([1],new Date(),0)).toThrow('RESEARCH_QUEUE_ROTATION_INVALID');
});
