import {test,expect} from '@playwright/test';
import {mkdtemp,readFile,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {DepartureTerminalCheckpoints} from '../../demand/terminal-checkpoints';
import type {ExecutionEntry} from '../../demand/executor';
import {DemandManager} from '../../demand/manager';
import {readDemandConfig} from '../../demand/config';
import type {AircraftSnapshot} from '../../demand/types';

const airplane=():AircraftSnapshot=>({
 aircraftId:'1',routeId:'10',registration:'TEST',routeLabel:'AAA - GRU',
 from:'AAA',to:'GRU',state:'ready',capacity:{Y:100,J:0,F:0},
 remaining:{Y:500,J:0,F:0},dailyTotal:{Y:1000,J:0,F:0},observedAt:new Date().toISOString()
});
const baseEntry=():ExecutionEntry=>{
 const a=airplane();
 const decision=new DemandManager(readDemandConfig({})).analyze({
  complete:true,expectedRoutes:1,warnings:[],aircraft:[a]
 },new Date()).decisions[0];
 return {aircraftId:a.aircraftId,routeId:a.routeId,registration:a.registration,
  from:a.from,to:a.to,status:'held',reason:'DATA_UNAVAILABLE',
  demand:decision,actualOnboard:null};
};

test('confirmed departures checkpoint before end of run and deduplicate across further saves',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'am4-checkpoint-'));
 try{
  await writeFile(join(dir,'return-journal.json'),JSON.stringify({schemaVersion:1,scope:'unit',entries:[]}));
  const writer=new DepartureTerminalCheckpoints(dir,'unit','123');
  const hold=baseEntry();
  expect(await writer.flush([hold])).toEqual({departed:0,uncertain:0});
  const departed:ExecutionEntry={...hold,status:'departed',
    reason:'NATIVE_INFLIGHT_IDENTITY_COUNTDOWN_AND_ONBOARD_CONFIRMED',
    actualOnboard:{Y:90,J:0,F:0}};
  expect(await writer.flush([departed])).toEqual({departed:1,uncertain:0});
  const saved=JSON.parse(await readFile(join(dir,'return-journal.json'),'utf8'));
  expect(saved.events).toHaveLength(1);
  expect(saved.events[0]).toMatchObject({type:'departure',eventId:'dep_123_1_10',result:'departed'});
  expect(await writer.flush([departed])).toEqual({departed:0,uncertain:0});
  const after=JSON.parse(await readFile(join(dir,'return-journal.json'),'utf8'));
  expect(after.events).toHaveLength(1);
 }finally{await rm(dir,{recursive:true,force:true});}
});

test('an unknown click is quarantined before processing next aircraft and never becomes a departure',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'am4-quarantine-'));
 try{
  await writeFile(join(dir,'return-journal.json'),JSON.stringify({schemaVersion:1,scope:'unit',entries:[]}));
  const writer=new DepartureTerminalCheckpoints(dir,'unit','124');
  const unknown:ExecutionEntry={...baseEntry(),status:'outcome_unknown',
    reason:'NO_RETRY_AFTER_CLICK_ATTEMPT:CONFIRMATION_MISSING'};
  expect(await writer.flush([unknown])).toEqual({departed:0,uncertain:1});
  const j=JSON.parse(await readFile(join(dir,'return-journal.json'),'utf8'));
  expect(j.events).toHaveLength(1);
  expect(j.events[0]).toMatchObject({type:'departure-uncertain',eventId:'unc_124_1_10'});
  expect(await writer.flush([unknown])).toEqual({departed:0,uncertain:0});
 }finally{await rm(dir,{recursive:true,force:true});}
});
