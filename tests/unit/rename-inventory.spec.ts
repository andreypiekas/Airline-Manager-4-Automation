import {test,expect,type Page} from '@playwright/test';
import {collectRenameInventory,renameCardIdentityIssue,retryOneUnstableReadOnlyFleetSnapshot} from '../../fleet-rename/inventory';

async function fixture(page:Page,options:{short?:boolean;duplicate?:boolean;siblingRegistration?:boolean;duplicateRegistration?:boolean}={}){
 await page.setContent(`<button>Routes (21)</button>
 <div id="routesContainer"></div><script>
 const opts=${JSON.stringify(options)};
 window.detailsOpened=0;window.pageAdvances=0;
 function render(index){
  const ids=index===0?Array.from({length:opts.short?19:20},(_,i)=>i+1):[21];
  const root=document.getElementById('routesContainer');
  root.innerHTML=ids.map(n=>{
   const route=n===21&&opts.duplicate?102:100+n;
   const aircraft=1000+n;
   return '<div class="row classPAX" id="routeMainList'+route+'">'+
    '<span class="s-text">AAA - GRU</span>'+
    '<a onclick="playSound(\\'neutral_click\\');Ajax(\\'fleet_details.php?id='+aircraft+'\\',\\'detailsAction\\');if(intro==0){$(\\'#routeAction\\').hide();}">'+
    (opts.siblingRegistration?'':'<span id="acRegList'+aircraft+'">N-'+n+'</span>')+
    ' - Plane</a>'+
    (opts.siblingRegistration?'<span id="acRegList'+aircraft+'">N-'+n+'</span>':'')+
    (opts.duplicateRegistration?'<span id="acRegList'+aircraft+'">WRONG</span>':'')+
    '</div>';
  }).join('')+(index===0?'<div class="pagination"><a href="#" onclick="Ajax(\\'routes.php?start=20&sort=\\',\\'routeAction\\',this);">Next</a></div>':'');
 }
 function Ajax(url){if(url.includes('routes.php?start=20')){window.pageAdvances++;render(1);}else window.detailsOpened++;}
 function playSound(){}const intro=0;function $(s){return {hide(){}}}
 render(0);
 </script>`);
}
test('fast identity-only inventory covers all native Fleet pages without opening details',async({page})=>{
 await fixture(page);
 const stages:string[]=[];
 const result=await collectRenameInventory(page,1600,stage=>stages.push(stage));
 expect(stages).toEqual([
  'COLLECT_FLEET_PAGE_1_WAIT_ROWS','COLLECT_FLEET_PAGE_1_READ_CARDS',
  'COLLECT_FLEET_PAGE_1_NEXT','COLLECT_FLEET_PAGE_2_WAIT_ROWS',
  'COLLECT_FLEET_PAGE_2_READ_CARDS'
 ]);
 expect(result.complete).toBe(true);
 expect(result.expectedRoutes).toBe(21);
 expect(result.aircraft).toHaveLength(21);
 expect(result.aircraft[0]).toMatchObject({aircraftId:'1001',routeId:'101',registration:'N-1',routeLabel:'AAA - GRU'});
 expect(result.aircraft.at(-1)).toMatchObject({aircraftId:'1021',routeId:'121'});
 expect(await page.evaluate(()=>(window as any).pageAdvances)).toBe(1);
 expect(await page.evaluate(()=>(window as any).detailsOpened)).toBe(0);
});
test('partial page timeout records safe page stage without inventing a fleet',async({page})=>{
 await fixture(page,{short:true});
 const stages:string[]=[];
 await expect(collectRenameInventory(page,250,stage=>stages.push(stage))).rejects.toThrow();
 expect(stages).toEqual(['COLLECT_FLEET_PAGE_1_WAIT_ROWS']);
 expect(stages.join(' ')).not.toContain('1001');
 expect(stages.join(' ')).not.toContain('AAA');
 expect(await page.evaluate(()=>(window as any).detailsOpened)).toBe(0);
});
test('only read-only manual runs receive a longer page timeout',async()=>{
 const source=await (await import('node:fs/promises')).readFile('fleet-rename/run.ts','utf8');
 expect(source).toContain("const timeout=operation==='preview'||operation==='pilot-check'?25000:14000;");
 expect(source).toContain('collectRenameInventory(page,timeout,markStage)');
 expect(source).toContain("if(operation==='apply')throw Error('RENAME_BULK_REQUIRES_VALIDATED_PILOT')");
});

test('Fleet inventory accepts a unique ID-matched registration sibling, not a foreign or ambiguous name',async({page})=>{
 await fixture(page,{siblingRegistration:true});
 const result=await collectRenameInventory(page,1400);
 expect(result.complete).toBe(true);
 expect(result.aircraft).toHaveLength(21);
 expect(result.aircraft[0].registration).toBe('N-1');
 expect(await page.evaluate(()=>(window as any).detailsOpened)).toBe(0);
 await page.goto('about:blank');
 await fixture(page,{siblingRegistration:true,duplicateRegistration:true});
 await expect(collectRenameInventory(page,1400)).rejects.toThrow('RENAME_FLEET_REGISTRATION_MISSING');
});
test('Fleet rejection has safe distinct codes without including identifiers or private labels',()=>{
 const good={routeId:'101',aircraftId:'1001',registration:'N-1',
  routeLabel:'AAA - GRU',detailsControlCount:1};
 const set=new Set<string>();
 expect(renameCardIdentityIssue(good,set,set)).toBeNull();
 const scenarios=[
  [{...good,routeId:''},'RENAME_FLEET_ROUTE_ID_INVALID'],
  [{...good,detailsControlCount:2},'RENAME_FLEET_DETAILS_CONTROL_AMBIGUOUS'],
  [{...good,aircraftId:''},'RENAME_FLEET_AIRCRAFT_ID_INVALID'],
  [{...good,registration:''},'RENAME_FLEET_REGISTRATION_MISSING'],
  [{...good,routeLabel:'UNKNOWN'},'RENAME_FLEET_ROUTE_LABEL_MISSING_OR_INVALID'],
 ] as const;
 for(const [card,code] of scenarios){
  const result=renameCardIdentityIssue(card,set,set);
  expect(result).toBe(code);
  expect(result).not.toContain(good.registration);
  expect(result).not.toContain(good.routeId);
 }
 expect(renameCardIdentityIssue(good,new Set([good.routeId]),set))
  .toBe('RENAME_FLEET_ROUTE_ID_DUPLICATE');
 expect(renameCardIdentityIssue(good,set,new Set([good.aircraftId])))
  .toBe('RENAME_FLEET_AIRCRAFT_ID_DUPLICATE');
});
test('short or repeated native page identities prevent renaming any aircraft',async({page})=>{
 await fixture(page,{short:true});
 await expect(collectRenameInventory(page,500)).rejects.toThrow();
 // Reload a fresh JS realm before the second synthetic native page.
 await page.goto('about:blank');
 await fixture(page,{duplicate:true});
 await expect(collectRenameInventory(page,1500)).rejects.toThrow('RENAME_FLEET_ROUTE_ID_DUPLICATE');
});

test('a read-only count drift discards the first snapshot and retries exactly once',async()=>{
 const phases:string[]=[];let attempts=0,reopens=0;
 const result=await retryOneUnstableReadOnlyFleetSnapshot(async()=>{
  attempts++;
  if(attempts===1)throw Error('RENAME_FLEET_COUNT_CHANGED');
  return {count:104,source:'fresh-second-snapshot'};
 },async()=>{reopens++;phases.push('fresh-fleet-open');},()=>phases.push('discard-partial'));
 expect(result).toEqual({count:104,source:'fresh-second-snapshot'});
 expect(attempts).toBe(2);
 expect(reopens).toBe(1);
 expect(phases).toEqual(['discard-partial','fresh-fleet-open']);
});
test('a second count change fails closed: no third collection and no mutation',async()=>{
 let attempts=0,reopens=0;
 await expect(retryOneUnstableReadOnlyFleetSnapshot(async()=>{
  attempts++;throw Error('RENAME_FLEET_COUNT_CHANGED');
 },async()=>{reopens++;})).rejects.toThrow('RENAME_FLEET_COUNT_CHANGED');
 expect(attempts).toBe(2);expect(reopens).toBe(1);
});
test('a read-only duplicate route ID discards the first full snapshot and retries once',async()=>{
 let attempts=0,reopens=0,discards=0;
 const fresh=await retryOneUnstableReadOnlyFleetSnapshot(async()=>{
  attempts++;
  if(attempts===1)throw Error('RENAME_FLEET_ROUTE_ID_DUPLICATE');
  return {complete:true,expectedRoutes:126,aircraft:[{aircraftId:'1',routeId:'2'}]};
 },async()=>{reopens++;},()=>{discards++;});
 expect(fresh).toMatchObject({complete:true,expectedRoutes:126});
 expect(attempts).toBe(2);
 expect(reopens).toBe(1);
 expect(discards).toBe(1);
});
test('persistent duplicate route or aircraft IDs abort after only two full snapshots',async()=>{
 for(const issue of ['RENAME_FLEET_ROUTE_ID_DUPLICATE','RENAME_FLEET_AIRCRAFT_ID_DUPLICATE']){
  let attempts=0,reopens=0;
  await expect(retryOneUnstableReadOnlyFleetSnapshot(async()=>{
   attempts++;throw Error(issue);
  },async()=>{reopens++;})).rejects.toThrow(issue);
  expect(attempts).toBe(2);expect(reopens).toBe(1);
 }
});
test('a different identity or control failure never starts a duplicate retry',async()=>{
 for(const issue of ['RENAME_FLEET_DETAILS_CONTROL_AMBIGUOUS','RENAME_FLEET_REGISTRATION_MISSING',
  'RENAME_FLEET_ROUTE_LABEL_MISSING_OR_INVALID','RENAME_FLEET_PAGE_INCOMPLETE']){
  let attempts=0,reopens=0;
  await expect(retryOneUnstableReadOnlyFleetSnapshot(async()=>{
   attempts++;throw Error(issue);
  },async()=>{reopens++;})).rejects.toThrow(issue);
  expect(attempts).toBe(1);expect(reopens).toBe(0);
 }
});
test('a mixed count-drift then duplicate failure does not cause a third inventory',async()=>{
 let attempts=0;
 await expect(retryOneUnstableReadOnlyFleetSnapshot(async()=>{
  attempts++;
  throw Error(attempts===1?'RENAME_FLEET_COUNT_CHANGED':'RENAME_FLEET_ROUTE_ID_DUPLICATE');
 },async()=>{})).rejects.toThrow('RENAME_FLEET_ROUTE_ID_DUPLICATE');
 expect(attempts).toBe(2);
});
test('nonrecoverable identity failures are never retried or silently accepted',async()=>{
 let attempts=0,reopens=0;
 await expect(retryOneUnstableReadOnlyFleetSnapshot(async()=>{
  attempts++;throw Error('RENAME_FLEET_REGISTRATION_MISSING');
 },async()=>{reopens++;})).rejects.toThrow('RENAME_FLEET_REGISTRATION_MISSING');
 expect(attempts).toBe(1);expect(reopens).toBe(0);
});
test('only the read-only modes invoke count-drift recovery; a real pilot never retries',async()=>{
 const runner=await (await import('node:fs/promises')).readFile('fleet-rename/run.ts','utf8');
 expect(runner).toContain("operation==='preview'||operation==='pilot-check'");
 expect(runner).toContain('retryOneUnstableReadOnlyFleetSnapshot');
 expect(runner).toContain(':await collect();');
 expect(runner).toContain("if(operation==='apply')throw Error('RENAME_BULK_REQUIRES_VALIDATED_PILOT')");
});
