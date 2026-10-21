import {test,expect} from '@playwright/test';
import {mkdtemp,readFile,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {checkpointDeferredDispatchQueue,readPendingDeferredDispatchKeys,pendingDeferredDispatchKeys} from '../../optimization/deferred-dispatch';
import {validateReturnJournal,type DeferredDispatchEvent,type Journal} from '../../optimization/return-journal';
import {compactReturnJournalForTransport} from '../../optimization/github-state';
import type {ExecutionEntry} from '../../demand/executor';

const scope='company-test';
const hold=(aircraftId:string,routeId:string,reason:string,status:ExecutionEntry['status']='held'):ExecutionEntry=>({
 aircraftId,routeId,registration:'TEST-'+aircraftId,from:'AAA',to:'GRU',status,reason,
 demand:null,actualOnboard:null
});
const budget='RUN_TIME_BUDGET_EXHAUSTED_BEFORE_EVALUATION';

test('only actual time-deferred aircraft cross run boundaries and rechecks clear old priority',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'am4-deferred-'));
 try{
  await writeFile(join(dir,'return-journal.json'),JSON.stringify({schemaVersion:1,scope,entries:[]}));
  let r=await checkpointDeferredDispatchQueue(dir,scope,'100',[
   hold('1','10',budget),
   hold('2','11','FUEL_STOCK_INSUFFICIENT_BY_VERIFIED_HISTORY'),
   hold('3','12','RUN_TIME_BUDGET_EXHAUSTED_BEFORE_MUTATION')
  ]);
  expect(r).toEqual({deferred:2,rechecked:0,pending:2});
  expect([...(await readPendingDeferredDispatchKeys(dir,scope))].sort()).toEqual(['1:10','3:12']);
  // A new cycle freshly reevaluates 1; 3 remains deferred and route 2 is
  // still a normal fuel hold. Neither result is departure authorization.
  r=await checkpointDeferredDispatchQueue(dir,scope,'101',[
   hold('1','10','DEMAND_INSUFFICIENT'),
   hold('2','11','FUEL_STOCK_INSUFFICIENT_BY_VERIFIED_HISTORY'),
   hold('3','12',budget)
  ]);
  expect(r).toEqual({deferred:1,rechecked:1,pending:1});
  expect([...(await readPendingDeferredDispatchKeys(dir,scope))]).toEqual(['3:12']);
  const saved=validateReturnJournal(JSON.parse(await readFile(join(dir,'return-journal.json'),'utf8')),scope,new Date());
  expect(saved.events?.filter(e=>e.type==='dispatch-deferred')).toHaveLength(3);
  expect(saved.events?.filter(e=>e.type==='dispatch-deferred-rechecked')).toHaveLength(1);
  // Repeated persistence of the same run does not repeat events.
  expect(await checkpointDeferredDispatchQueue(dir,scope,'101',[hold('1','10','DEMAND_INSUFFICIENT'),hold('3','12',budget)]))
   .toEqual({deferred:0,rechecked:0,pending:1});
 }finally{await rm(dir,{recursive:true,force:true});}
});

test('priority is bound to aircraft AND route, and transport compaction keeps last state',()=>{
 const event=(n:number,type:DeferredDispatchEvent['type'],id='1',route='10'):DeferredDispatchEvent=>({
  eventId:'dq_'+n,type,aircraftId:id,routeId:route,sourceRunId:String(n),
  observedAt:new Date(Date.now()-10000+n*1000).toISOString(),
  reason:type==='dispatch-deferred'?'RUN_TIME_BUDGET_EXHAUSTED_BEFORE_EVALUATION':'REEVALUATED_IN_NEW_RUN'
 });
 const j:Journal={schemaVersion:1,scope,entries:[],events:[
  event(1,'dispatch-deferred'),event(2,'dispatch-deferred-rechecked'),
  event(3,'dispatch-deferred','1','11'),event(4,'dispatch-deferred','2','10')
 ]};
 expect([...pendingDeferredDispatchKeys(j)].sort()).toEqual(['1:11','2:10']);
 const compacted=compactReturnJournalForTransport(j);
 expect(compacted.events).toHaveLength(3);
 expect([...pendingDeferredDispatchKeys(compacted)].sort()).toEqual(['1:11','2:10']);
 expect(()=>validateReturnJournal(compacted,scope,new Date())).not.toThrow();
});

test('malformed deferred event cannot be restored from remote state',()=>{
 const bad={schemaVersion:1,scope,entries:[],events:[{
  eventId:'dq_1',type:'dispatch-deferred',aircraftId:'1',routeId:'10',
  sourceRunId:'1',observedAt:new Date().toISOString(),reason:'SKIP_DEMAND_VERIFICATION'
 }]};
 expect(()=>validateReturnJournal(bad,scope,new Date())).toThrow('JOURNAL_INVALID');
});

test('deferred queue never accepts duplicate aircraft-route entries in a cycle',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'am4-deferred-'));
 try{
  await writeFile(join(dir,'return-journal.json'),JSON.stringify({schemaVersion:1,scope,entries:[]}));
  await expect(checkpointDeferredDispatchQueue(dir,scope,'100',[hold('1','10',budget),hold('1','10',budget)]))
   .rejects.toThrow('DEFERRED_QUEUE_DUPLICATE_IDENTITY');
  expect(JSON.parse(await readFile(join(dir,'return-journal.json'),'utf8')).events).toBeUndefined();
 }finally{await rm(dir,{recursive:true,force:true});}
});
