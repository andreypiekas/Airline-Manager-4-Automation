import {test,expect,type Page} from '@playwright/test';
import {collectRenameInventory} from '../../fleet-rename/inventory';
import {assertRenameDetailAirportsMatch} from '../../fleet-rename/plan';

/** Synthetic native Fleet only: never a live account or mutation action. */
async function fixture(page:Page,wrongAirports=false,headingText='Routes (3)'){
 await page.setContent(`<button id="mapRoutes" onclick="hideAllWhenClick();menuFleet('Routes');">Fleet</button>
  <button>${headingText}</button>
  <div id="routeAction"><div id="routesContainer"></div></div>
  <div id="detailsAction" style="display:none"></div>
  <script>
  window.detailsOpened=0;window.mutations=0;
  const intro=0;
  function hideAllWhenClick(){} function playSound(){}
  function $(selector){return {hide(){const el=document.querySelector(selector);if(el)el.style.display='none';}}}
  function render(){
   const root=document.getElementById('routesContainer');root.innerHTML='';
   for(let n=1;n<=3;n++){
    const row=document.createElement('div');
    row.id='routeMainList'+(100+n);row.className='row classPAX';
    row.innerHTML='<span class="s-text">AAA - GRU</span>';
    const link=document.createElement('a');link.href='#';
    link.setAttribute('onclick',"playSound('neutral_click');Ajax('fleet_details.php?id="+(1000+n)+"','detailsAction');if(intro==0){$('#routeAction').hide();}");
    if(n!==3){
     const reg=document.createElement('span');reg.id='acRegList'+(1000+n);reg.textContent='N-'+n;
     link.appendChild(reg);link.append(' - Aircraft');
    }else link.textContent='N-3 - Aircraft';
    row.appendChild(link);root.appendChild(row);
   }
  }
  function menuFleet(){
   document.getElementById('routesContainer').remove();
   const fresh=document.createElement('div');fresh.id='routesContainer';
   document.getElementById('routeAction').appendChild(fresh);
   document.getElementById('routeAction').style.display='block';
   document.getElementById('detailsAction').style.display='none';render();
  }
  function Ajax(path){
   if(!path.startsWith('fleet_details.php?id='))throw Error('not native details');
   window.detailsOpened++;
   const id=Number(path.match(/id=(\\d+)/)[1]);
   const details=document.getElementById('detailsAction');
   details.innerHTML='<div id="ff-name">N-'+(id-1000)+'</div>'+
    '<div class="col-5"><span class="l-text">${wrongAirports?'CCC':'AAA'}</span>'+
    '<span class="l-text">GRU</span></div>';
   details.style.display='block';
  }
  render();
  </script>`);
}
test('absent card registration can be verified by the exact native read-only details route',async({page})=>{
 await fixture(page);
 const result=await collectRenameInventory(page,1800);
 expect(result.complete).toBe(true);
 expect(result.expectedRoutes).toBe(3);
 expect(result.aircraft.map(a=>a.registration)).toEqual(['N-1','N-2','N-3']);
 expect(await page.evaluate(()=>(window as any).detailsOpened)).toBe(1);
 expect(await page.evaluate(()=>(window as any).mutations)).toBe(0);
});
test('native Fleet headings with no space or non-breaking spaces keep the same verified numeric count',async({page})=>{
 for(const heading of ['Routes(3)','Routes\u00a0(3)']){
  await fixture(page,false,heading);
  const result=await collectRenameInventory(page,1800);
  expect(result.complete).toBe(true);
  expect(result.aircraft).toHaveLength(3);
  expect(result.aircraft[2].registration).toBe('N-3');
  await page.goto('about:blank');
 }
});
test('details endpoint mismatch cannot make a preview complete or enable edits',async({page})=>{
 await fixture(page,true);
 await expect(collectRenameInventory(page,1500))
  .rejects.toThrow('RENAME_DETAILS_ROUTE_ENDPOINTS_UNVERIFIED');
 expect(await page.evaluate(()=>(window as any).detailsOpened)).toBe(1);
 expect(await page.evaluate(()=>(window as any).mutations)).toBe(0);
});
test('native two-airport detail proof rejects extra and missing fields',()=>{
 expect(()=>assertRenameDetailAirportsMatch('AAA - GRU',['GRU','AAA'])).not.toThrow();
 expect(()=>assertRenameDetailAirportsMatch('AAA - GRU',['AAA'])).toThrow('RENAME_DETAILS_ROUTE_ENDPOINTS_UNVERIFIED');
 expect(()=>assertRenameDetailAirportsMatch('AAA - GRU',['AAA','GRU','AAA'])).toThrow('RENAME_DETAILS_ROUTE_ENDPOINTS_UNVERIFIED');
});
