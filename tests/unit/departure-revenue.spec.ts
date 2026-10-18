import {test,expect} from '@playwright/test';
import { estimatedGrossTicketRevenue } from '../../demand/revenue';

const fares=(current: {Y:number;J:number;F:number}|null)=>({
  source:'inspected-auto-control' as const,automatic:{Y:100,J:200,F:300},current
});

test('gross value uses verified actual onboard counts and live fare values',()=>{
  expect(estimatedGrossTicketRevenue({Y:80,J:5,F:2},fares({Y:100,J:300,F:900}))).toBe(11300);
});
test('unverified or absent fare is not converted into invented zero revenue',()=>{
  expect(estimatedGrossTicketRevenue({Y:80,J:0,F:0},undefined)).toBeNull();
  expect(estimatedGrossTicketRevenue({Y:80,J:0,F:0},fares(null))).toBeNull();
  expect(estimatedGrossTicketRevenue({Y:80,J:0,F:0},{...fares({Y:100,J:0,F:0}),source:'unavailable'})).toBeNull();
  expect(estimatedGrossTicketRevenue({Y:80,J:0,F:0},fares({Y:0,J:0,F:0}))).toBeNull();
});
test('malformed passenger and fare values or unsafe multiplication remain unavailable',()=>{
  expect(estimatedGrossTicketRevenue({Y:-1,J:0,F:0},fares({Y:100,J:0,F:0}))).toBeNull();
  expect(estimatedGrossTicketRevenue({Y:2,J:0,F:0},fares({Y:Number.MAX_SAFE_INTEGER,J:0,F:0}))).toBeNull();
  expect(estimatedGrossTicketRevenue({Y:2,J:0,F:0},fares({Y:NaN,J:0,F:0}))).toBeNull();
});
test('a verified zero-passenger flight produces zero, not a missing fare claim',()=>{
  expect(estimatedGrossTicketRevenue({Y:0,J:0,F:0},fares({Y:120,J:0,F:0}))).toBe(0);
});
