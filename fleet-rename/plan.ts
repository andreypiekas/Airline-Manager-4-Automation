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
 const digest=createHash('sha256').update(JSON.stringify(targets)).digest('hex');
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
