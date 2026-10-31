import { test, expect } from '@playwright/test';
import { parseFlightHistoryRow, isRecognizedRecalledFlightHistoryRow, readFlightHistoryEvidence } from '../../optimization/flight-history';

test('parses inspected AM4 flight history row exactly',()=>{
  expect(parseFlightHistoryRow('49 mins ago GRU-DEL 340-200-6 624,220 Quotas Y161 J12 F4 266,939 Lbs $1,284,400')).toEqual({
    relativeTime:'49 mins ago',from:'GRU',to:'DEL',registrationLabel:'340-200-6',
    co2Quotas:624220,onboard:{Y:161,J:12,F:4},fuelLbs:266939,revenue:1284400
  });
});

test('historical registration labels may differ without changing route evidence',()=>{
  const r=parseFlightHistoryRow('3 days ago GRU-MLE A340-200-5 428,586 Quotas Y116 J8 F5 238,428 Lbs $882,500');
  expect(r).toMatchObject({from:'GRU',to:'MLE',registrationLabel:'A340-200-5',onboard:{Y:116,J:8,F:5}});
});

for(const bad of [
  '49 mins ago GRU-GRU X 1 Quotas Y1 J1 F1 1 Lbs $1',
  '49 mins ago GRU-DEL X NaN Quotas Y1 J1 F1 1 Lbs $1',
  '49 mins ago GRU-DEL X 1 Quotas Y-1 J1 F1 1 Lbs $1',
  'GRU-DEL X 1 Quotas Y1 J1 F1 1 Lbs $1'
]) test('rejects malformed flight-history row '+bad,()=>expect(parseFlightHistoryRow(bad)).toBeNull());

test('reads visible flight-history window without clicks',async({page})=>{
  await page.setContent(`
    <div id="detailsAction">
      <div id="flight-history">
        <div class="row bg-light m-text p-1 border">49 mins ago GRU-DEL 340-200-6 624,220 Quotas Y161 J12 F4 266,939 Lbs $1,284,400</div>
        <div class="row bg-light m-text p-1 border">12 hours ago DEL-GRU 340-200-6 456,340 Quotas Y115 J10 F3 266,939 Lbs $938,850</div>
      </div>
      <button onclick="window.mutations=(window.mutations||0)+1">History</button>
    </div>`);
  const r=await readFlightHistoryEvidence(page.locator('#detailsAction'));
  expect(r.status).toBe('observed');
  expect(r.complete).toBe(false);
  expect(r.entries).toHaveLength(2);
  expect(r.entries[0].revenue).toBe(1284400);
  expect(r.navigationDiagnostics).toEqual([expect.objectContaining({tag:'button',text:'History',onclick:expect.stringContaining('window.mutations')})]);
  expect(r.comparisonReady).toBe(false);
  expect(r.mutationAuthorized).toBe(false);
  expect(await page.evaluate(()=>(window as any).mutations||0)).toBe(0);
});

test('one unrecognized visible history row fails the evidence closed',async({page})=>{
  await page.setContent('<div id="detailsAction"><div id="flight-history"><div class="row bg-light m-text p-1 border">unknown history format</div></div></div>');
  expect((await readFlightHistoryEvidence(page.locator('#detailsAction'))).status).toBe('unavailable');
});


const confirmedRecent='5 hours ago BWN-MQJ XP-166 184,627 Quotas Y50 J46 F9 136,335 Lbs $573,400';
const confirmedReturn='16 hours ago MQJ-BWN XP-166 179,169 Quotas Y49 J44 F9 136,335 Lbs $556,460';
const recalled='3 days ago BWN-MQJ XP-166 83,102 Quotas Recalled 136,335 Lbs $-260,383';

test('run #1230: AM4 recalled flight is not a completed fuel observation',()=>{
  expect(parseFlightHistoryRow(recalled)).toBeNull();
  expect(isRecognizedRecalledFlightHistoryRow(recalled)).toBe(true);
  for(const text of [
    '3 days ago BWN-MQJ XP-166 NaN Quotas Recalled 136,335 Lbs $-260,383',
    '3 days ago BWN-MQJ XP-166 83,102 Quotas Recalled -1 Lbs $-260,383',
    '3 days ago BWN-MQJ XP-166 83,102 Quotas Recalled 0 Lbs $-260,383',
    '3 days ago BWN-MQJ XP-166 83,102 Quotas Recalled 136,335 Lbs $260,383',
    '3 days ago BWN-BWN XP-166 83,102 Quotas Recalled 136,335 Lbs $-260,383',
    'other history row'
  ])expect(isRecognizedRecalledFlightHistoryRow(text)).toBe(false);
});

test('run #1230: 2+ strictly verified flights remain readable with a recognized Recalled record',async({page})=>{
  await page.setContent('<div id="detailsAction"><div id="flight-history">'+
    [confirmedRecent,recalled,confirmedReturn].map(x=>
      '<div class="row bg-light m-text p-1 border">'+x+'</div>').join('')+
    '</div><button onclick="window.mutations=(window.mutations||0)+1">History</button></div>');
  const evidence=await readFlightHistoryEvidence(page.locator('#detailsAction'));
  expect(evidence).toMatchObject({
    status:'observed',complete:false,excludedRecalledRows:1,
    source:'inspected-aircraft-flight-history',
    comparisonReady:false,mutationAuthorized:false
  });
  expect(evidence.entries).toHaveLength(2);
  expect(evidence.entries.map(x=>x.fuelLbs)).toEqual([136335,136335]);
  expect(evidence.entries.map(x=>x.from+'-'+x.to))
    .toEqual(['BWN-MQJ','MQJ-BWN']);
  expect(evidence.entries.every(x=>x.co2Quotas>0&&x.revenue>0)).toBe(true);
  expect(await page.evaluate(()=>(window as any).mutations||0)).toBe(0);
});

test('run #1230 safety: unknown/malformed row still invalidates whole history window',async({page})=>{
  await page.setContent('<div id="detailsAction"><div id="flight-history">'+
    [confirmedRecent,'3 days ago BWN-MQJ XP-166 83,102 Quotas SomethingElse 136,335 Lbs $-260,383',confirmedReturn]
      .map(x=>'<div class="row bg-light m-text p-1 border">'+x+'</div>').join('')+
    '</div></div>');
  const evidence=await readFlightHistoryEvidence(page.locator('#detailsAction'));
  expect(evidence).toMatchObject({status:'unavailable',entries:[],mutationAuthorized:false});
});

test('run #1230 safety: recalled record alone supplies no fuel evidence',async({page})=>{
  await page.setContent('<div id="detailsAction"><div id="flight-history">'+
    '<div class="row bg-light m-text p-1 border">'+recalled+'</div></div></div>');
  const evidence=await readFlightHistoryEvidence(page.locator('#detailsAction'));
  expect(evidence).toMatchObject({status:'unavailable',entries:[],mutationAuthorized:false});
});

const zeroDollarRecalled='1 day ago DEL-KTD XP-178 522 Quotas Recalled 353,464 Lbs $0';
const confirmedPp192Out='1 day ago DEL-IPC XP-179 1,318,588 Quotas Y385 J12 F13 417,939 Lbs $3,894,342';
const confirmedPp192Back='14 hours ago IPC-DEL XP-179 1,300,935 Quotas Y377 J13 F13 417,939 Lbs $3,842,059';

test('run #1249: zero-dollar recalled row is excluded while verified PP-192 fuel history remains readable',async({page})=>{
  expect(parseFlightHistoryRow(zeroDollarRecalled)).toBeNull();
  expect(isRecognizedRecalledFlightHistoryRow(zeroDollarRecalled)).toBe(true);
  await page.setContent('<div id="detailsAction"><div id="flight-history">'+
    [confirmedPp192Back,confirmedPp192Out,zeroDollarRecalled]
      .map(x=>'<div class="row bg-light m-text p-1 border">'+x+'</div>').join('')+
    '</div></div>');
  const evidence=await readFlightHistoryEvidence(page.locator('#detailsAction'));
  expect(evidence).toMatchObject({
    status:'observed',complete:false,excludedRecalledRows:1,
    comparisonReady:false,mutationAuthorized:false
  });
  expect(evidence.entries).toHaveLength(2);
  expect(evidence.entries.map(x=>x.fuelLbs)).toEqual([417939,417939]);
  expect(evidence.entries.map(x=>x.from+'-'+x.to)).toEqual(['IPC-DEL','DEL-IPC']);
  expect(evidence.entries.every(x=>x.revenue>0)).toBe(true);
});

test('run #1249 safety: zero-dollar recalled row alone never establishes fuel evidence',async({page})=>{
  await page.setContent('<div id="detailsAction"><div id="flight-history">'+
    '<div class="row bg-light m-text p-1 border">'+zeroDollarRecalled+'</div></div></div>');
  expect(await readFlightHistoryEvidence(page.locator('#detailsAction')))
    .toMatchObject({status:'unavailable',entries:[],mutationAuthorized:false});
  for(const bad of [
    zeroDollarRecalled.replace('$0','$00'),
    zeroDollarRecalled.replace('$0','$-0'),
    zeroDollarRecalled.replace('$0','$123'),
    zeroDollarRecalled.replace('DEL-KTD','DEL-DEL')
  ])expect(isRecognizedRecalledFlightHistoryRow(bad)).toBe(false);
});
