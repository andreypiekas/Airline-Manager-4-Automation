import {mkdir,open,readFile,rename,unlink} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {randomUUID} from 'node:crypto';
import {withRunLock} from '../utils/run-lock';
import {validateReturnJournal,type Journal,type DeferredDispatchEvent} from './return-journal';
import type {ExecutionEntry} from '../demand/executor';

const validId=(v:string)=>/^[A-Za-z0-9_-]{1,100}$/.test(v);
export const deferredKey=(aircraftId:string,routeId:string)=>aircraftId+':'+routeId;
export const timeDeferred=(e:Pick<ExecutionEntry,'status'|'reason'>)=>
 e.status==='held'&&(
  e.reason==='RUN_TIME_BUDGET_EXHAUSTED_BEFORE_EVALUATION'||
  e.reason==='RUN_TIME_BUDGET_EXHAUSTED_BEFORE_MUTATION'
 );

export function pendingDeferredDispatchKeys(journal:Journal):ReadonlySet<string>{
 const latest=new Map<string,DeferredDispatchEvent>();
 for(const e of journal.events||[]){
  if(e.type!=='dispatch-deferred'&&e.type!=='dispatch-deferred-rechecked')continue;
  const key=deferredKey(e.aircraftId,e.routeId),older=latest.get(key);
  // A concurrent upload may append observations from a different runner
  // out of chronological order. Resolve deterministically by timestamp.
  if(!older||Date.parse(e.observedAt)>Date.parse(older.observedAt)||
    (e.observedAt===older.observedAt&&e.eventId>older.eventId))latest.set(key,e);
 }
 return new Set([...latest].filter(([,e])=>e.type==='dispatch-deferred').map(([key])=>key));
}

export async function readPendingDeferredDispatchKeys(directory:string,scope:string,now=new Date()):Promise<ReadonlySet<string>>{
 const journal=validateReturnJournal(JSON.parse(await readFile(join(directory,'return-journal.json'),'utf8')),scope,now);
 return pendingDeferredDispatchKeys(journal);
}

/** Append a fully observed cycle's remaining time holds and clear any matching
 * prior pending items that were rechecked. Never turn queue priority into
 * authorization to dispatch: every future departure requires new game evidence.
 */
export async function checkpointDeferredDispatchQueue(
 directory:string,scope:string,runId:string,entries:ReadonlyArray<ExecutionEntry>,now=new Date()
):Promise<{deferred:number;rechecked:number;pending:number}>{
 if(!validId(scope)||!validId(runId)||!Number.isFinite(now.getTime()))throw Error('DEFERRED_QUEUE_CONFIG_INVALID');
 const root=resolve(directory);await mkdir(root,{recursive:true});
 return withRunLock(async()=>{
  const filename=join(root,'return-journal.json');
  const journal=validateReturnJournal(JSON.parse(await readFile(filename,'utf8')),scope,now);
  const active=pendingDeferredDispatchKeys(journal),events=[...(journal.events||[])];
  const observed=new Set<string>();
  let deferred=0,rechecked=0;
  for(const entry of entries){
   if(!validId(entry.aircraftId)||!validId(entry.routeId))throw Error('DEFERRED_QUEUE_IDENTITY_INVALID');
   const key=deferredKey(entry.aircraftId,entry.routeId);
   if(observed.has(key))throw Error('DEFERRED_QUEUE_DUPLICATE_IDENTITY');
   observed.add(key);
   const isDeferred=timeDeferred(entry);
   if(!isDeferred&&!active.has(key))continue;
   const type:DeferredDispatchEvent['type']=isDeferred?'dispatch-deferred':'dispatch-deferred-rechecked';
   const reason:DeferredDispatchEvent['reason']=isDeferred?entry.reason as DeferredDispatchEvent['reason']:'REEVALUATED_IN_NEW_RUN';
   const event:DeferredDispatchEvent={
    eventId:`dq_${isDeferred?'d':'r'}_${runId}_${entry.aircraftId}_${entry.routeId}`,
    type,aircraftId:entry.aircraftId,routeId:entry.routeId,
    observedAt:now.toISOString(),sourceRunId:runId,reason
   };
   if(events.some(e=>e.eventId===event.eventId))continue;
   events.push(event);
   if(isDeferred)deferred++;else rechecked++;
  }
  if(!deferred&&!rechecked)return {deferred:0,rechecked:0,pending:active.size};
  journal.events=events;
  validateReturnJournal(journal,scope,now);
  const temporary=join(root,`return-journal.${randomUUID()}.tmp`);
  try{
   const fh=await open(temporary,'wx',0o600);
   try{await fh.writeFile(JSON.stringify(journal,null,2)+'\n');await fh.sync();}finally{await fh.close();}
   await rename(temporary,filename);
  }finally{await unlink(temporary).catch(()=>undefined);}
  return {deferred,rechecked,pending:pendingDeferredDispatchKeys(journal).size};
 },join(root,'.return-journal.lock'));
}
