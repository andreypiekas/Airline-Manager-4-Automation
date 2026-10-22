import {expect,type Page} from '@playwright/test';
import type {CollectionResult,AircraftSnapshot} from '../demand/types';
import {AIRCRAFT_DETAILS_CONTROL,aircraftIdFromDetailsControl} from '../demand/identity';
import {assertNoInteractiveChallenge} from '../utils/challenge-guard';
import {routePageLimit,openFleetList,findFleetRoute} from '../demand/navigation';
import {assertRenameDetailAirportsMatch,assertRenameRouteLabelUnchanged} from './plan';

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
/** Missing card registrations can be read only through the exact, native
 * aircraft-details control for that same route. No rename handler is clicked.
 * The source fleet count, route endpoints and aircraft ID must be unchanged. */
export async function readMissingRegistrationFromNativeDetails(
 page:Page,item:AircraftSnapshot,expectedRoutes:number,timeout=15000
):Promise<string>{
 await assertNoInteractiveChallenge(page,'rename:missing-registration');
 await openFleetList(page,timeout);
 const heading=page.getByRole('button',{name:/^Routes\s*\(\d+\)$/});
 const actual=(await heading.innerText({timeout})).trim();
 if(actual!=='Routes ('+expectedRoutes+')')throw Error('RENAME_FLEET_COUNT_CHANGED');
 await findFleetRoute(page,item,timeout);
 const row=page.locator('#routesContainer #routeMainList'+item.routeId);
 if(await row.count()!==1||!await row.isVisible())
  throw Error('RENAME_FLEET_DETAILS_ROUTE_NOT_VISIBLE');
 assertRenameRouteLabelUnchanged(item.routeLabel,await row.locator('span.s-text').allTextContents());
 if(await row.locator('[id^="acRegList"]').count()!==0)
  throw Error('RENAME_FLEET_REGISTRATION_CONTEXT_CHANGED');
 const links=row.locator('a[onclick]');
 const callbacks=await links.evaluateAll(es=>es.map(e=>e.getAttribute('onclick')||''));
 const indices=callbacks.flatMap((v,i)=>aircraftIdFromDetailsControl(v)===item.aircraftId?[i]:[]);
 if(indices.length!==1)throw Error('RENAME_FLEET_DETAILS_CONTROL_UNVERIFIED');
 const link=links.nth(indices[0]);
 if(!await link.isVisible())throw Error('RENAME_FLEET_DETAILS_CONTROL_UNVERIFIED');
 const details=page.locator('#detailsAction');
 if(await details.isVisible())throw Error('RENAME_FLEET_DETAILS_STALE');
 await assertNoInteractiveChallenge(page,'rename:missing-registration-before-open');
 await link.click({timeout});
 await details.waitFor({state:'visible',timeout});
 await assertNoInteractiveChallenge(page,'rename:missing-registration-opened');
 const name=details.locator('#ff-name');
 if(await name.count()!==1||!await name.isVisible())
  throw Error('RENAME_FLEET_DETAILS_REGISTRATION_UNVERIFIED');
 const registration=(await name.innerText({timeout})).trim();
 if(!registration)throw Error('RENAME_FLEET_DETAILS_REGISTRATION_UNVERIFIED');
 assertRenameDetailAirportsMatch(item.routeLabel,
  await details.locator('.col-5 span.l-text').allTextContents());
 return registration;
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
 const missing:AircraftSnapshot[]=[];
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
   // A missing DOM registration is not permission to invent a name: defer
   // only this exact case to independently verified native details, after
   // the full route identity scan. Empty/duplicate/mismatched nodes still fail.
   const deferred=card.registrationShape==='ABSENT'&&
    card.detailsControlCount===1&&!card.registration;
   const issue=renameCardIdentityIssue(
    deferred?{...card,registration:'DEFERRED_READ_ONLY'}:card,routes,ids);
   if(deferred&&!issue)console.log('[RenameInventory] '+JSON.stringify({
    source:'MANUAL_GAME_OR_OFFLINE',status:'NATIVE_DETAILS_DEFERRED',
    page:pageIndex,slot:slot+1,observed:result.aircraft.length,expected:total
   }));
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
   if(deferred)missing.push(item);
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
 // Resolve only the exceptional cards, never infer registration from generic
 // text. Reopen verified native Fleet and details for each one. Any mismatch
 // invalidates the *entire* proposal; nothing is authorized until complete.
 for(const [index,item] of missing.entries()){
  console.log('[RenameInventory] '+JSON.stringify({
   status:'READ_ONLY_DETAILS_LOOKUP',item:index+1,total:missing.length
  }));
  item.registration=await readMissingRegistrationFromNativeDetails(page,item,total,timeout);
 }
 if(!result.aircraft.every(a=>a.registration.trim()))
  throw Error('RENAME_FLEET_DETAILS_REGISTRATION_UNVERIFIED');
 result.complete=true;
 return result;
}
