import {test,expect} from '@playwright/test';
import {generateRenames,exportRenameCsv,mappingTemplate,parseRenameCsv,authorizeRenameOperation,verifiedFleet,assertRenameRouteLabelUnchanged} from '../../fleet-rename/plan';
import {verifiedPromptRenameCallback,safeRenameFailureCode} from '../../fleet-rename/run';
import type {CollectionResult,AircraftSnapshot} from '../../demand/types';
function item(aircraftId:string,routeId:string,registration:string):AircraftSnapshot{
 return {aircraftId,routeId,registration,routeLabel:'AAA - GRU',from:'AAA',to:'GRU',
  state:'ready',capacity:null,remaining:null,dailyTotal:null,observedAt:new Date().toISOString()};
}
const fleet=():CollectionResult=>({
 complete:true,expectedRoutes:3,warnings:[],aircraft:[item('10','100','N-10'),item('3','99','N-3'),item('2','98','N-2')]
});
test('full Fleet preview generates a deterministic CSV and hash using stable identities',()=>{
 const plan=generateRenames(fleet(),{aircraftPrefix:'XP',routePrefix:'RT'});
 expect(plan.targets.map(x=>[x.aircraftId,x.routeId,x.aircraftRegistration,x.routeRegistration]))
  .toEqual([['2','98','XP-001','RT-001'],['3','99','XP-002','RT-002'],['10','100','XP-003','RT-003']]);
 expect(plan.digest).toMatch(/^[a-f0-9]{64}$/);
 expect(generateRenames(fleet(),{aircraftPrefix:'XP',routePrefix:'RT'}).digest).toBe(plan.digest);
 expect(exportRenameCsv(plan).split('\n')[0])
  .toBe('aircraftId,routeId,aircraftRegistration,routeRegistration');
 expect(mappingTemplate(fleet())).toContain('2,98,,');
 expect(parseRenameCsv(exportRenameCsv(plan))).toHaveLength(3);
 expect(authorizeRenameOperation('preview','','',plan)).toBe(false);
 expect(authorizeRenameOperation('apply','APLICAR_RENOMEACAO_TOTAL',plan.digest,plan)).toBe(true);
});
test('manual apply refuses missing confirmation, changed plan or mismatched route',()=>{
 const plan=generateRenames(fleet(),{aircraftPrefix:'XP',routePrefix:'RT'});
 for(const [approval,digest] of [['',plan.digest],['APLICAR_RENOMEACAO_TOTAL','0'.repeat(64)]]){
  expect(()=>authorizeRenameOperation('apply',approval,digest,plan)).toThrow('RENAME_CONFIRMATION');
 }
 const changed=fleet();changed.aircraft[0].registration='CHANGED';
 const other=generateRenames(changed,{aircraftPrefix:'XP',routePrefix:'RT'});
 expect(other.digest).not.toBe(plan.digest);
 const csv=exportRenameCsv(plan).replace('2,98,','2,999,');
 expect(()=>generateRenames(fleet(),{csv})).toThrow('RENAME_CSV_IDENTITY_MISMATCH');
});
test('all-aircraft mapping strictly rejects partial, duplicated and injected names',()=>{
 const plan=generateRenames(fleet(),{aircraftPrefix:'XP',routePrefix:'RT'});
 const csv=exportRenameCsv(plan);
 expect(()=>generateRenames(fleet(),{csv:csv.split('\n').slice(0,3).join('\n')}))
  .toThrow('RENAME_CSV_NOT_ENTIRE_FLEET');
 expect(()=>generateRenames(fleet(),{csv:csv.replace('XP-002','XP-001')}))
  .toThrow('RENAME_DUPLICATE_REGISTRATION');
 expect(()=>generateRenames(fleet(),{csv:csv.replace('XP-002','=IMPORT(A1)')}))
  .toThrow('RENAME_CSV_VALUE_INVALID');
 expect(()=>generateRenames(fleet(),{csv,aircraftPrefix:'XP',routePrefix:'RT'}))
  .toThrow('RENAME_MODE_AMBIGUOUS');
 expect(()=>generateRenames(fleet(),{aircraftPrefix:'XP'}))
  .toThrow('RENAME_PREFIX_INVALID');
});
test('an incomplete or ambiguous fleet cannot produce a mutation plan',()=>{
 const f=fleet();f.complete=false;
 expect(()=>verifiedFleet(f)).toThrow('RENAME_FLEET_INCOMPLETE');
 const duplicate=fleet();duplicate.aircraft[1].aircraftId='2';
 expect(()=>generateRenames(duplicate,{aircraftPrefix:'XP',routePrefix:'RT'}))
  .toThrow('RENAME_FLEET_IDENTITY_UNVERIFIED');
 const wrongCount=fleet();wrongCount.expectedRoutes=4;
 expect(()=>mappingTemplate(wrongCount)).toThrow('RENAME_FLEET_INCOMPLETE');
});
test('pre-save route identity rejects changed endpoints even if route and aircraft IDs persist',()=>{
 expect(()=>assertRenameRouteLabelUnchanged('AAA - GRU',['AAA - GRU'])).not.toThrow();
 expect(()=>assertRenameRouteLabelUnchanged('AAA - GRU',['AAA-GRU','AAA - GRU'])).not.toThrow();
 expect(()=>assertRenameRouteLabelUnchanged('AAA - GRU',['AAA - LAX']))
  .toThrow('RENAME_ROUTE_IDENTITY_CHANGED');
 expect(()=>assertRenameRouteLabelUnchanged('AAA - GRU',['AAA - GRU','GRU - AAA']))
  .toThrow('RENAME_ROUTE_IDENTITY_CHANGED');
 expect(()=>assertRenameRouteLabelUnchanged('AAA - GRU',['unknown route label']))
  .toThrow('RENAME_ROUTE_IDENTITY_CHANGED');
});
test('preview errors are classified without leaking raw Playwright/browser text',()=>{
 expect(safeRenameFailureCode(new Error('READ_ONLY_LOGIN_OR_LOADING_FAILED')))
  .toBe('READ_ONLY_LOGIN_OR_LOADING_FAILED');
 expect(safeRenameFailureCode(new Error('INTERACTIVE_CHALLENGE_DETECTED_STOP')))
  .toBe('INTERACTIVE_CHALLENGE_DETECTED_STOP');
 expect(safeRenameFailureCode(new Error('RENAME_FLEET_PAGE_INCOMPLETE')))
  .toBe('RENAME_FLEET_PAGE_INCOMPLETE');
 expect(safeRenameFailureCode(new Error('RESEARCH_LIST_CONTROL_UNVERIFIED')))
  .toBe('RESEARCH_LIST_CONTROL_UNVERIFIED');
 expect(safeRenameFailureCode(new Error('Timeout 14000ms exceeded while reading form with private details')))
  .toBe('RENAME_UI_WAIT_TIMEOUT');
 expect(safeRenameFailureCode(new Error('a secret credential or HTML dump')))
  .toBe('RENAME_UNCLASSIFIED_FAILURE');
});
test('only one native prompt/AJAX save callback for the exact field and ID is supported',()=>{
 const original=(id:string,mode:string)=>"Ajax('fleet_details.php?id="+id+"&mode="+mode+"&reg='+prompt('Change name'),'detailsAction');";
 expect(verifiedPromptRenameCallback(original('2','reg'),'2','reg')).toBe(true);
 expect(verifiedPromptRenameCallback(original('98','routeReg'),'98','routeReg')).toBe(true);
 expect(verifiedPromptRenameCallback(original('2','routeReg'),'2','reg')).toBe(false);
 expect(verifiedPromptRenameCallback(original('22','reg'),'2','reg')).toBe(false);
 expect(verifiedPromptRenameCallback("unknownAction('fleet_details.php?id=2&mode=reg&')",'2','reg')).toBe(false);
});
