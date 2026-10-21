import {test,expect,type Page} from '@playwright/test';
import {collectRenameInventory} from '../../fleet-rename/inventory';

async function fixture(page:Page,options:{short?:boolean;duplicate?:boolean}={}){
 await page.setContent(`<button>Routes (21)</button>
 <div id="routesContainer"></div><script>
 const opts=${JSON.stringify(options)};
 window.detailsOpened=0;window.pageAdvances=0;
 function render(index){
  const ids=index===0?Array.from({length:opts.short?19:20},(_,i)=>i+1):[21];
  const root=document.getElementById('routesContainer');
  root.innerHTML=ids.map(n=>{
   const route=n===21&&opts.duplicate?101:100+n;
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
test('short or repeated native page identities prevent renaming any aircraft',async({page})=>{
 await fixture(page,{short:true});
 await expect(collectRenameInventory(page,500)).rejects.toThrow();
 await fixture(page,{duplicate:true});
 await expect(collectRenameInventory(page,1500)).rejects.toThrow('RENAME_FLEET_DUPLICATE_OR_INVALID_IDENTITY');
});
