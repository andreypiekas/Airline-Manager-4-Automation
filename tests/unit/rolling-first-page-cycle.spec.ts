import { expect, test } from '@playwright/test';
import {
  observeRollingFirstPage, RollingFirstPagePlanner
} from '../../demand/rolling-first-page-cycle';
import type {
  FirstPageAircraft, FirstPageObservation
} from '../../demand/rolling-first-page';

const aircraft=(id:number,state:FirstPageAircraft['state']='ready'):FirstPageAircraft=>({
  aircraftId:String(1000+id),routeId:String(2000+id),
  registration:'TEST-'+id,state
});
const window=(aircraftList:FirstPageAircraft[],options:{
  routeTotal?:number,status?:FirstPageObservation['status']
}={}):FirstPageObservation=>({
  status:options.status??(aircraftList.length===Math.min(options.routeTotal??142,20)?'STABLE':'SHORT_PAGE'),
  routeTotal:options.routeTotal??142,
  visible:aircraftList.length,ready:aircraftList.filter(x=>x.state==='ready').length,
  aircraft:aircraftList,mutationAuthorized:false
});

test('after landing, the same identity becomes a newly-ready candidate without traversing Next',async()=>{
  const first=window([aircraft(1,'inflight'),aircraft(2,'unavailable')]);
  const landed=window([aircraft(1,'ready'),aircraft(2,'unavailable')]);
  const snapshots=[first,landed,landed];
  let cursor=0;
  const report=await observeRollingFirstPage(async()=>snapshots[cursor++],{
    maxWindows:3,maxConsecutiveWithoutNewReady:2
  });
  expect(cursor).toBe(3);
  expect(report.windows.map(w=>w.newlyReady)).toEqual([0,1,0]);
  expect(report.windows.map(w=>w.firstSeen)).toEqual([2,0,0]);
  expect(report.windows[1].firstPageChanged).toBe(true);
  expect(report.totalKnownAircraft).toBe(2);
  expect(report.totalNewReady).toBe(1);
  expect(report.mutationAuthorized).toBe(false);
  expect(report.stopReason).toBe('MAX_WINDOWS');
});

test('a departure-like first-page shift reveals the next ready aircraft only once',async()=>{
  const first=window([aircraft(1,'ready'),aircraft(2,'inflight'),aircraft(3,'unavailable')]);
  const shifted=window([aircraft(1,'inflight'),aircraft(4,'ready'),aircraft(2,'inflight')]);
  const planner=new RollingFirstPagePlanner();
  const a=planner.inspect(first);
  expect(a.status).toBe('OK');
  expect(a.candidates.map(x=>x.aircraftId)).toEqual(['1001']);
  planner.recordConfirmedResult('1001','2001','departed');
  const b=planner.inspect(shifted);
  expect(b.candidates.map(x=>x.aircraftId)).toEqual(['1004']);
  expect(b.summary.firstSeen).toBe(1);
  expect(b.summary.firstPageChanged).toBe(true);
  expect(planner.inspect(shifted).candidates).toEqual([]);
  expect(()=>planner.recordConfirmedResult('1001','2001','departed')).toThrow('FIRST_PAGE_RESULT_ALREADY_RECORDED');
  expect(b.summary.mutationAuthorized).toBe(false);
});

test('maintenance/unavailable on page one is not mistaken for a removed aircraft',async()=>{
  const first=window([aircraft(1,'unavailable'),aircraft(2,'ready')],{routeTotal:142});
  const second=window([aircraft(2,'ready'),aircraft(3,'unavailable')],{routeTotal:142});
  const planner=new RollingFirstPagePlanner();
  expect(planner.inspect(first).candidates.map(a=>a.registration)).toEqual(['TEST-2']);
  const next=planner.inspect(second);
  expect(next.status).toBe('OK');
  expect(next.summary.uniqueObserved).toBe(3);
  expect(next.summary.newlyReady).toBe(0);
  expect(next.summary.firstPageChanged).toBe(true);
  expect(next.summary.mutationAuthorized).toBe(false);
});

test('same aircraft ID reassigned to another route fails closed before accepting any card',()=>{
  const planner=new RollingFirstPagePlanner();
  planner.inspect(window([aircraft(1),aircraft(2)]));
  const changed=window([aircraft(3),{...aircraft(1),routeId:'9999'}]);
  const result=planner.inspect(changed);
  expect(result.status).toBe('IDENTITY_DRIFT');
  expect(result.candidates).toEqual([]);
  expect(result.summary.firstSeen).toBe(0);
  expect(result.summary.uniqueObserved).toBe(2);
});

test('route reused by a different aircraft, invalid identity and duplicate card all fail closed',()=>{
  const planner=new RollingFirstPagePlanner();
  planner.inspect(window([aircraft(1)]));
  expect(planner.inspect(window([{...aircraft(2),routeId:'2001'}])).status).toBe('IDENTITY_DRIFT');
  expect(new RollingFirstPagePlanner().inspect(window([aircraft(1),aircraft(1)])).status)
    .toBe('IDENTITY_DRIFT');
  expect(new RollingFirstPagePlanner().inspect(window([{...aircraft(1),aircraftId:'0'}])).status)
    .toBe('IDENTITY_DRIFT');
});

test('uncertain result cannot be re-queued when it remains visible',()=>{
  const planner=new RollingFirstPagePlanner(),sample=window([aircraft(1)]);
  expect(planner.inspect(sample).candidates).toHaveLength(1);
  planner.recordConfirmedResult('1001','2001','uncertain');
  expect(planner.inspect(sample).candidates).toHaveLength(0);
  expect(()=>planner.recordConfirmedResult('1001','2001','departed')).toThrow('FIRST_PAGE_RESULT_ALREADY_RECORDED');
});

test('invalid, unstable and impossible page totals never produce candidates',async()=>{
  for(const observation of [
    window([aircraft(1)],{status:'UNSTABLE'}),
    {...window([aircraft(1)]),routeTotal:null},
    {...window([aircraft(1)]),visible:20},
    {...window([aircraft(1)]),ready:0}
  ]){
    const report=await observeRollingFirstPage(async()=>observation);
    expect(report.stopReason).toBe('WINDOW_UNVERIFIED');
    expect(report.totalNewReady).toBe(0);
    expect(report.mutationAuthorized).toBe(false);
  }
});

test('unchanged first page ends after two scans without any newly ready aircraft',async()=>{
  let observations=0;
  const sample=window([aircraft(1,'inflight')]);
  const result=await observeRollingFirstPage(async()=>{observations++;return sample;},{
    maxWindows:8,maxConsecutiveWithoutNewReady:2
  });
  expect(observations).toBe(2);
  expect(result.stopReason).toBe('NO_NEW_READY');
});

test('a ready card is not an unlimited reason to rescan a frozen page',async()=>{
  let observations=0;
  const sample=window([aircraft(1)]);
  const result=await observeRollingFirstPage(async()=>{observations++;return sample;},{
    maxWindows:8,maxConsecutiveWithoutNewReady:2
  });
  expect(observations).toBe(3); // 1 new ready + 2 no progress
  expect(result.totalNewReady).toBe(1);
  expect(result.stopReason).toBe('NO_NEW_READY');
});

test('near deadline, no Fleet read is made and no mutation is authorized',async()=>{
  let invoked=false;
  const result=await observeRollingFirstPage(async()=>{
    invoked=true;return window([aircraft(1)]);
  },{deadlineEpochMs:Date.now()+9000});
  expect(invoked).toBe(false);
  expect(result.stopReason).toBe('TIME_BUDGET');
  expect(result.windows).toEqual([]);
});

test('wrong settings reject before any Fleet interaction',async()=>{
  await expect(observeRollingFirstPage(async()=>window([aircraft(1)]),{
    maxWindows:9
  })).rejects.toThrow('ROLLING_FIRST_PAGE_SETTINGS_INVALID');
});
