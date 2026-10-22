import {expect,type Page} from '@playwright/test';
import type {CollectionResult,AircraftSnapshot} from '../demand/types';
import {AIRCRAFT_DETAILS_CONTROL} from '../demand/identity';
import {assertNoInteractiveChallenge} from '../utils/challenge-guard';
import {routePageLimit} from '../demand/navigation';

interface RenameCardIdentity {
 routeId:string;aircraftId:string;registration:string;routeLabel:string;detailsControlCount:number;
}
/** Pure, privacy-safe diagnosis. Keep integrity checks strict; never expose actual IDs,
 * registration, route label, URLs or callbacks in CI logs. */
export function renameCardIdentityIssue(
 card:RenameCardIdentity,seenRoutes:ReadonlySet<string>,seenAircraft:ReadonlySet<string>
):string|null{
 if(!/^[1-9]\d*$/.test(card.routeId))return 'RENAME_FLEET_ROUTE_ID_INVALID';
 if(card.detailsControlCount!==1)return 'RENAME_FLEET_DETAILS_CONTROL_AMBIGUOUS';
 if(!/^[1-9]\d*$/.test(card.aircraftId))return 'RENAME_FLEET_AIRCRAFT_ID_INVALID';
 if(!card.registration.trim())return 'RENAME_FLEET_REGISTRATION_MISSING';
 if(!/^[A-Z0-9]{3}\s*-\s*[A-Z0-9]{3}$/.test(card.routeLabel))
  return 'RENAME_FLEET_ROUTE_LABEL_MISSING_OR_INVALID';
 if(seenRoutes.has(card.routeId))return 'RENAME_FLEET_ROUTE_ID_DUPLICATE';
 if(seenAircraft.has(card.aircraftId))return 'RENAME_FLEET_AIRCRAFT_ID_DUPLICATE';
 return null;
}
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
   // Fleet registration may be rendered as a sibling of the native details
   // link. Resolve it only within THIS verified route card and require exactly
   // one registration node with the exact aircraft ID; never borrow a name
   // from another card or infer it from generic visible text.
   const registrationNodes=Array.from(e.querySelectorAll('[id^="acRegList"]'));
   const matchingRegistration=registrationNodes.length===1&&
    registrationNodes[0].id==='acRegList'+aircraftId ? registrationNodes[0] : null;
   const registration=matchingRegistration?.textContent?.trim()||'';
   const registrationShape=registrationNodes.length===0?'ABSENT':
    registrationNodes.length!==1?'AMBIGUOUS':
    !matchingRegistration?'ID_MISMATCH':!registration?'EMPTY':
    links.length===1&&links[0].a.contains(matchingRegistration)?'NESTED':'CARD_SIBLING';
   const routeLabel=Array.from(e.querySelectorAll('span.s-text')).map(x=>x.textContent?.trim()||'')
    .find(x=>/^[A-Z0-9]{3}\s*-\s*[A-Z0-9]{3}$/.test(x))||'';
   return {routeId:e.id.replace(/^routeMainList/,''),aircraftId,registration,routeLabel,
    detailsControlCount:links.length,registrationShape};
  }),AIRCRAFT_DETAILS_CONTROL);
  if(cards.length!==expected)throw Error('RENAME_FLEET_PAGE_INCOMPLETE');
  for(const [slot,card] of cards.entries()){
   const issue=renameCardIdentityIssue(card,routes,ids);
   if(issue){
    // Only classification and position are emitted; raw identities are never logged.
    console.warn('[RenameInventory] '+JSON.stringify({status:'INVALID_CARD',
     source:process.env.RENAME_OPERATION==='preview'||process.env.RENAME_OPERATION==='apply'
      ?'MANUAL_GAME':'OFFLINE_TEST',
     page:pageIndex,slot:slot+1,observed:result.aircraft.length,expected:total,
     code:issue,registrationShape:card.registrationShape}));
    throw Error(issue);
   }
   const segments=card.routeLabel.split(/\s*-\s*/);
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
