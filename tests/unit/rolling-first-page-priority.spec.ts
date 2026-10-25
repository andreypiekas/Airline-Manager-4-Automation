import { expect, test } from '@playwright/test';
import {
  orderVerifiedDepartureCandidates,verifiedFirstPagePriorityKeys
} from '../../demand/rolling-first-page-priority';
import type { AircraftSnapshot, CollectionResult } from '../../demand/types';
import type { FirstPageObservation } from '../../demand/rolling-first-page';

const aircraft=(id:number,state:AircraftSnapshot['state']='ready'):AircraftSnapshot=>({
  aircraftId:String(2000+id),routeId:String(1000+id),registration:'TEST-'+id,
  routeLabel:'DTW - DAC',from:'DTW',to:'DAC',state,
  capacity:{Y:100,J:0,F:0},remaining:{Y:100,J:0,F:0},
  dailyTotal:{Y:300,J:0,F:0},observedAt:new Date().toISOString()
});
const inventory=(rows:AircraftSnapshot[]=Array.from({length:22},(_,i)=>aircraft(i+1))):CollectionResult=>({
  complete:true,expectedRoutes:rows.length,aircraft:rows,warnings:[]
});
const first=(items:AircraftSnapshot[],fleetSize=22):FirstPageObservation=>({
  status:items.length===Math.min(fleetSize,20)?'STABLE':'SHORT_PAGE',
  routeTotal:fleetSize,visible:items.length,
  ready:items.filter(a=>a.state==='ready').length,
  aircraft:items.map(({aircraftId,routeId,registration,state})=>({
    aircraftId,routeId,registration,state
  })),mutationAuthorized:false
});

test('first page contributes ONLY matched ready priority after a full same-run fleet',()=>{
  const full=inventory();
  const hint=verifiedFirstPagePriorityKeys(full,first(full.aircraft.slice(0,20)));
  expect(hint.size).toBe(20);
  expect(hint.has('2001:1001')).toBe(true);
  expect(hint.has('2022:1022')).toBe(false);
  const shorter=verifiedFirstPagePriorityKeys(full,first(full.aircraft.slice(0,19)));
  expect(shorter.size).toBe(19);
});

test('full-fleet incompleteness, count drift, duplicates and mismatched native identity are never priority',()=>{
  const full=inventory();
  const one=first(full.aircraft.slice(0,20));
  expect(verifiedFirstPagePriorityKeys({...full,complete:false},one).size).toBe(0);
  expect(verifiedFirstPagePriorityKeys({...full,expectedRoutes:23},one).size).toBe(0);
  expect(verifiedFirstPagePriorityKeys(full,{...one,routeTotal:23}).size).toBe(0);
  expect(verifiedFirstPagePriorityKeys(full,{...one,status:'UNSTABLE'}).size).toBe(0);
  expect(verifiedFirstPagePriorityKeys(full,{...one,aircraft:[
    {...one.aircraft[0],registration:'TAMPERED'},...one.aircraft.slice(1)
  ]}).size).toBe(0);
  expect(verifiedFirstPagePriorityKeys(full,{...one,aircraft:[
    {...one.aircraft[0],aircraftId:'2002'},...one.aircraft.slice(1)
  ]}).size).toBe(0);
  const duplicated=inventory([aircraft(1),{...aircraft(1),routeId:'9999'}]);
  expect(verifiedFirstPagePriorityKeys(duplicated,first([aircraft(1)],2)).size).toBe(0);
});

test('a recently landed aircraft is not promoted from inflight to ready by a page hint',()=>{
  const rows=[aircraft(1,'inflight'),aircraft(2,'ready')];
  const observed=first([aircraft(1,'ready'),aircraft(2,'ready')],2);
  expect(verifiedFirstPagePriorityKeys(inventory(rows),observed).size).toBe(0);
  expect(orderVerifiedDepartureCandidates(inventory(rows),new Set(),new Set())
    .map(a=>a.aircraftId)).toEqual(['2002']);
});

test('persisted deferred work outranks matched first page, then original inventory order',()=>{
  const rows=[aircraft(1),aircraft(2),aircraft(3),aircraft(4,'inflight')];
  const full=inventory(rows);
  const selected=verifiedFirstPagePriorityKeys(full,first([rows[1]],4));
  const ordered=orderVerifiedDepartureCandidates(full,new Set(['2003:1003']),selected);
  expect(ordered.map(a=>a.aircraftId)).toEqual(['2003','2002','2001']);
  expect(orderVerifiedDepartureCandidates({...full,complete:false},
    new Set(['2003:1003']),selected).map(a=>a.aircraftId))
    .toEqual(['2001','2002','2003']);
});

test('priority is a scheduling hint, not a mutation gate or synthetic fleet record',()=>{
  const full=inventory([aircraft(1),aircraft(2)]);
  const read=first([full.aircraft[1]],2);
  const hint=verifiedFirstPagePriorityKeys(full,read);
  expect(hint.has('2002:1002')).toBe(true);
  expect(read.mutationAuthorized).toBe(false);
  expect(full.complete).toBe(true);
  expect(full.aircraft).toHaveLength(2);
  expect(orderVerifiedDepartureCandidates(full,new Set(),hint)[0].aircraftId)
    .toBe('2002');
});
