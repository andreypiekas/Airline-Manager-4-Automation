import {expect,type Page} from '@playwright/test';
import type {CollectionResult,AircraftSnapshot} from '../demand/types';
import {AIRCRAFT_DETAILS_CONTROL} from '../demand/identity';
import {assertNoInteractiveChallenge} from '../utils/challenge-guard';
import {routePageLimit} from '../demand/navigation';

/**
 * Unlike demand analysis, administrative renaming needs ONLY the read-only
 * identities from native Fleet cards. No per-plane demand, history or price
 * details are opened in the inventory pass. On incomplete native pagination,
 * refuse the entire plan instead of silently renaming a subset.
 */
export async function collectRenameInventory(page:Page,timeout=15000):Promise<CollectionResult>{
 await assertNoInteractiveChallenge(page,'rename:inventory');
 const heading=page.getByRole('button',{name:/^Routes\s*\(\d+\)$/});
 if(await heading.count()!==1)throw Error('RENAME_FLEET_COUNT_UNVERIFIED');
 const parseTotal=(label:string)=>{
  const match=/^Routes\s*\((\d+)\)$/.exec(label.trim());
  if(!match)return null;const n=Number(match[1]);
  return Number.isSafeInteger(n)&&n>0?n:null;
 };
 const total=parseTotal(await heading.innerText({timeout}));
 if(!total)throw Error('RENAME_FLEET_COUNT_UNVERIFIED');
 const result:CollectionResult={complete:false,expectedRoutes:total,aircraft:[],warnings:[]};
 const routes=new Set<string>(),ids=new Set<string>(),maxPages=routePageLimit(total,20);
 const routeRows=page.locator('#routesContainer [id^="routeMainList"]');
 for(let pageIndex=0;pageIndex<maxPages;pageIndex++){
  await assertNoInteractiveChallenge(page,'rename:inventory-page');
  if(parseTotal(await heading.innerText({timeout}))!==total)throw Error('RENAME_FLEET_COUNT_CHANGED');
  const expected=Math.min(20,total-pageIndex*20);
  await expect.poll(async()=>routeRows.evaluateAll(es=>es.filter(e=>!!e.getClientRects().length).length),
   {timeout}).toBe(expected);
  const cards=await routeRows.evaluateAll((elements,pattern)=>elements.filter(e=>!!e.getClientRects().length).map(e=>{
   const links=Array.from(e.querySelectorAll('a')).flatMap(a=>{
    const id=(a.getAttribute('onclick')||'').replace(/\s/g,'').match(new RegExp(pattern))?.[1];
    return id?[{a,id}]:[];
   });
   const aircraftId=links.length===1?links[0].id:'';
   const registration=links.length===1?links[0].a.querySelector('#acRegList'+aircraftId)?.textContent?.trim()||'':'';
   const routeLabel=Array.from(e.querySelectorAll('span.s-text')).map(x=>x.textContent?.trim()||'')
    .find(x=>/^[A-Z0-9]{3}\s*-\s*[A-Z0-9]{3}$/.test(x))||'';
   return {routeId:e.id.replace(/^routeMainList/,''),aircraftId,registration,routeLabel};
  }),AIRCRAFT_DETAILS_CONTROL);
  if(cards.length!==expected)throw Error('RENAME_FLEET_PAGE_INCOMPLETE');
  for(const card of cards){
   const segments=card.routeLabel.split(/\s*-\s*/);
   if(!/^[1-9]\d*$/.test(card.routeId)||!/^[1-9]\d*$/.test(card.aircraftId)||
      !card.registration||segments.length!==2||routes.has(card.routeId)||ids.has(card.aircraftId))
    throw Error('RENAME_FLEET_DUPLICATE_OR_INVALID_IDENTITY');
   routes.add(card.routeId);ids.add(card.aircraftId);
   const item:AircraftSnapshot={
    aircraftId:card.aircraftId,routeId:card.routeId,registration:card.registration,
    routeLabel:card.routeLabel,from:segments[0],to:segments[1],
    state:'unavailable',capacity:null,remaining:null,dailyTotal:null,observedAt:new Date().toISOString()
   };
   result.aircraft.push(item);
  }
  if(pageIndex===maxPages-1)break;
  const next=page.locator('#routesContainer .pagination').getByRole('link',{name:'Next',exact:true});
  const native=`Ajax('routes.php?start=${(pageIndex+1)*20}&sort=','routeAction',this);`;
  if(await next.count()!==1||(await next.getAttribute('onclick')||'').replace(/\s/g,'')!==native)
   throw Error('RENAME_FLEET_NEXT_CONTROL_UNVERIFIED');
  const oldFirst=cards[0].routeId;
  await next.click({timeout});
  await expect.poll(()=>routeRows.evaluateAll(es=>es.find(e=>!!e.getClientRects().length)?.id||null),
   {timeout}).not.toBe('routeMainList'+oldFirst);
 }
 if(result.aircraft.length!==total||routes.size!==total||ids.size!==total||
    parseTotal(await heading.innerText({timeout}))!==total)throw Error('RENAME_FLEET_FINAL_COUNT_INCOMPLETE');
 result.complete=true;
 return result;
}
