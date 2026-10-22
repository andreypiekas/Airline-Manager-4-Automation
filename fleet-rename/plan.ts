import {createHash} from 'node:crypto';
import type {CollectionResult,AircraftSnapshot} from '../demand/types';
export interface RenameTarget {
  aircraftId:string;routeId:string;
  oldAircraftRegistration:string;oldRouteLabel:string;
  aircraftRegistration:string;routeRegistration:string;
}
export interface RenamePlan {schemaVersion:1;count:number;digest:string;targets:RenameTarget[]}
const code=/^[A-Za-z0-9][A-Za-z0-9 ._-]{0,31}$/;
const id=/^[1-9]\d*$/;
const header='aircraftId,routeId,aircraftRegistration,routeRegistration';
const csvCell=(s:string)=>s.replace(/\r|\n|,/g,' ');
export function mappingTemplate(collection:CollectionResult):string{
 const fleet=verifiedFleet(collection);
 return [header,...fleet.map(a=>[a.aircraftId,a.routeId,'',''].join(','))].join('\n')+'\n';
}
/** Verify the current route endpoints at the moment a rename target is opened.
 * IDs alone cannot prove a route is still the one from the approved preview.
 * This is read-only and refuses mismatches or ambiguous native labels.
 */
/** Flight direction can reverse when an aircraft lands or departs.
 * Route identity is the exact UNORDERED airport pair plus the existing
 * routeId/aircraftId checked separately, never its current direction.
 * Strictly reject unknown airport formats rather than silently normalizing.
 */
export function canonicalRenameAirportPair(label:string):string{
 const match=/^([A-Z0-9]{3})\s*-\s*([A-Z0-9]{3})$/.exec(label.trim());
 if(!match||match[1]===match[2])throw Error('RENAME_ROUTE_IDENTITY_CHANGED');
 return [match[1],match[2]].sort().join('-');
}
export function assertRenameRouteLabelUnchanged(expected:string,labels:string[]):void{
 const baseline=canonicalRenameAirportPair(expected);
 const current=labels.flatMap(label=>{
  try{return [canonicalRenameAirportPair(label)];}
  catch{return [];}
 });
 if(current.length===0||current.some(value=>value!==baseline))
  throw Error('RENAME_ROUTE_IDENTITY_CHANGED');
}
/** Native details use two individual airport labels rather than the card's
 * AAA - BBB label. This proves both endpoints before accepting a missing card
 * registration, never trusting a naked #ff-name value alone. */
export function assertRenameDetailAirportsMatch(routeLabel:string,airports:string[]):void{
 const route=/^([A-Z0-9]{3})\s*-\s*([A-Z0-9]{3})$/.exec(routeLabel.trim());
 const observed=airports.map(x=>x.trim());
 if(!route||observed.length!==2||
    !observed.every(x=>/^[A-Z0-9]{3}$/.test(x))||
    [route[1],route[2]].sort().join(':')!==observed.sort().join(':'))
  throw Error('RENAME_DETAILS_ROUTE_ENDPOINTS_UNVERIFIED');
}
export function verifiedFleet(collection:CollectionResult):AircraftSnapshot[]{
 if(!collection?.complete||!Number.isSafeInteger(collection.expectedRoutes)||
 collection.expectedRoutes===null||collection.expectedRoutes<=0||collection.expectedRoutes!==collection.aircraft.length)
  throw Error('RENAME_FLEET_INCOMPLETE');
 const routeIds=new Set<string>(),aircraftIds=new Set<string>();
 for(const a of collection.aircraft){
  if(!id.test(a.aircraftId)||!id.test(a.routeId)||!a.registration?.trim()||
  !a.routeLabel?.trim()||routeIds.has(a.routeId)||aircraftIds.has(a.aircraftId))
    throw Error('RENAME_FLEET_IDENTITY_UNVERIFIED');
  routeIds.add(a.routeId);aircraftIds.add(a.aircraftId);
 }
 return [...collection.aircraft].sort((a,b)=>Number(a.aircraftId)-Number(b.aircraftId));
}
export function parseRenameCsv(csv:string):Array<Pick<RenameTarget,'aircraftId'|'routeId'|'aircraftRegistration'|'routeRegistration'>>{
 const rows=csv.trim().split(/\r?\n/);
 if(rows[0]?.trim()!==header||rows.length<2||rows.length>10001)throw Error('RENAME_CSV_HEADER_OR_SIZE_INVALID');
 const seen=new Set<string>();
 return rows.slice(1).map(line=>{
  const values=line.split(',').map(v=>v.trim());
  if(values.length!==4)throw Error('RENAME_CSV_ROW_INVALID');
  const [aircraftId,routeId,aircraftRegistration,routeRegistration]=values;
  if(!id.test(aircraftId)||!id.test(routeId)||!code.test(aircraftRegistration)||!code.test(routeRegistration))
   throw Error('RENAME_CSV_VALUE_INVALID');
  const key=aircraftId+':'+routeId;
  if(seen.has(key))throw Error('RENAME_CSV_DUPLICATE_ID');seen.add(key);
  return {aircraftId,routeId,aircraftRegistration,routeRegistration};
 });
}
export function generateRenames(
 collection:CollectionResult,options:{csv?:string;aircraftPrefix?:string;routePrefix?:string}
):RenamePlan{
 const fleet=verifiedFleet(collection);
 const hasCsv=!!options.csv?.trim(),hasPattern=!!options.aircraftPrefix?.trim()||!!options.routePrefix?.trim();
 if(hasCsv===hasPattern)throw Error('RENAME_MODE_AMBIGUOUS');
 let rows:Array<Pick<RenameTarget,'aircraftId'|'routeId'|'aircraftRegistration'|'routeRegistration'>>;
 if(hasCsv)rows=parseRenameCsv(options.csv!);
 else{
  const aircraftPrefix=options.aircraftPrefix?.trim()||'',routePrefix=options.routePrefix?.trim()||'';
  if(!code.test(aircraftPrefix)||!code.test(routePrefix)||aircraftPrefix.length>20||routePrefix.length>20)
   throw Error('RENAME_PREFIX_INVALID');
  const width=Math.max(3,String(fleet.length).length);
  rows=fleet.map((a,i)=>({
   aircraftId:a.aircraftId,routeId:a.routeId,
   aircraftRegistration:aircraftPrefix+'-'+String(i+1).padStart(width,'0'),
   routeRegistration:routePrefix+'-'+String(i+1).padStart(width,'0')
  }));
 }
 if(rows.length!==fleet.length)throw Error('RENAME_CSV_NOT_ENTIRE_FLEET');
 const map=new Map(rows.map(x=>[x.aircraftId+':'+x.routeId,x]));
 const aircraftRegs=new Set<string>(),routeRegs=new Set<string>();
 const targets=fleet.map(a=>{
  const newValues=map.get(a.aircraftId+':'+a.routeId);
  if(!newValues)throw Error('RENAME_CSV_IDENTITY_MISMATCH');
  const {aircraftRegistration,routeRegistration}=newValues;
  if(aircraftRegs.has(aircraftRegistration)||routeRegs.has(routeRegistration))
   throw Error('RENAME_DUPLICATE_REGISTRATION');
  aircraftRegs.add(aircraftRegistration);routeRegs.add(routeRegistration);
  return {
   aircraftId:a.aircraftId,routeId:a.routeId,oldAircraftRegistration:a.registration,
   oldRouteLabel:a.routeLabel,aircraftRegistration,routeRegistration
  };
 });
 // The hash must stay invariant under ordinary flight direction reversals,
 // but still bind every aircraftId, routeId, registration, exact airport pair,
 // intended aircraftRegistration and intended routeRegistration. The visible
 // targets retain their original labels for subsequent live UI verification.
 const digestTargets=targets.map(t=>({
  ...t,oldRouteLabel:canonicalRenameAirportPair(t.oldRouteLabel)
 }));
 const digest=createHash('sha256').update(JSON.stringify(digestTargets)).digest('hex');
 return {schemaVersion:1,count:targets.length,digest,targets};
}
export function exportRenameCsv(plan:RenamePlan){
 return [header,...plan.targets.map(t=>[t.aircraftId,t.routeId,csvCell(t.aircraftRegistration),csvCell(t.routeRegistration)].join(','))].join('\n')+'\n';
}
export function authorizeRenameOperation(
 operation:string,confirmation:string,expectedDigest:string,plan:RenamePlan
):boolean{
 if(operation==='preview')return false;
 if(operation!=='apply'||confirmation!=='APLICAR_RENOMEACAO_TOTAL'||!/^[a-f0-9]{64}$/.test(expectedDigest)||
  expectedDigest!==plan.digest)throw Error('RENAME_CONFIRMATION_INVALID_OR_FLEET_CHANGED');
 return true;
}


/** Explicitly authorize ONE aircraft from the entire validated preview.
 * The full-fleet digest binds identity, current registration and route endpoints.
 * Never fall back to the first aircraft or an implicit selection.
 */
/** Read-only selection binds the exact aircraft to the approved full-fleet hash.
 * Does not grant permission to mutate anything.
 */
export function selectSingleAircraftPilotTarget(
 plan:RenamePlan,aircraftId:string,expectedDigest:string
):RenameTarget{
 if(!/^[1-9]\d*$/.test(aircraftId)||
    !/^[a-f0-9]{64}$/.test(expectedDigest)||expectedDigest!==plan.digest)
  throw Error('RENAME_PILOT_AUTHORIZATION_OR_FLEET_CHANGED');
 const selected=plan.targets.filter(t=>t.aircraftId===aircraftId);
 if(selected.length!==1)throw Error('RENAME_PILOT_TARGET_NOT_FOUND');
 return selected[0];
}
export function authorizeSingleAircraftPilot(
 plan:RenamePlan,aircraftId:string,expectedDigest:string,confirmation:string
):RenameTarget{
 if(confirmation!=='APLICAR_PILOTO_UMA_AERONAVE')
  throw Error('RENAME_PILOT_AUTHORIZATION_OR_FLEET_CHANGED');
 return selectSingleAircraftPilotTarget(plan,aircraftId,expectedDigest);
}
