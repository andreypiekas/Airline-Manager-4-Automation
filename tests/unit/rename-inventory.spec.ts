import {test,expect,type Page} from '@playwright/test';
import {collectRenameInventory,renameCardIdentityIssue} from '../../fleet-rename/inventory';

async function fixture(page:Page,options:{short?:boolean;duplicate?:boolean}={}){
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
    '<span id="acRegList'+aircraft+'">N-'+n+'</span> - Plane</a></div>';
  }).join('')+(index===0?'<div class="pagination"><a href="#" onclick="Ajax(\\'routes.php?start=20&sort=\\',\\'routeAction\\',this);">Next</a></div>':'');
 }
 function Ajax(url){if(url.includes('routes.php?start=20')){window.pageAdvances++;render(1);}else window.detailsOpened++;}
 function playSound(){}const intro=0;function $(s){return {hide(){}}}
 render(0);
 </script>`);
}
test('fast identity-only inventory covers all native Fleet pages without opening details',async({page})=>{
 await fixture(page);
 const result=await collectRenameInventory(page,1600);
 expect(result.complete).toBe(true);
 expect(result.expectedRoutes).toBe(21);
 expect(result.aircraft).toHaveLength(21);
 expect(result.aircraft[0]).toMatchObject({aircraftId:'1001',routeId:'101',registration:'N-1',routeLabel:'AAA - GRU'});
 expect(result.aircraft.at(-1)).toMatchObject({aircraftId:'1021',routeId:'121'});
 expect(await page.evaluate(()=>(window as any).pageAdvances)).toBe(1);
 expect(await page.evaluate(()=>(window as any).detailsOpened)).toBe(0);
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
