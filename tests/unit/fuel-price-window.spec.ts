import {test,expect} from '@playwright/test';
import type {FuelCalendar} from '../../optimization/reference-data';
import {fuelPriceWindow} from '../../supplies/fuel-price-window';

const calendar=(days:FuelCalendar['days'],monthLength:30|31=31):FuelCalendar=>({
 monthLength,utcOffsetMinutes:-180,source:'fixture',status:'ocr-unverified',days
});
const day=(n:number,fuel:number[][]):FuelCalendar['days'][number]=>({
 day:n,page:n+1,verified:false,fuel,co2:[],fuelIssues:false,co2Issues:false
});

test('proximo horario acessivel e melhor preco em 24h com comparacao ao live',()=>{
 const result=fuelPriceWindow(
  new Date('2026-10-17T23:45:00Z'),
  calendar([day(17,[[1200,560],[1260,700],[1290,450],[1320,380]])]),
  620,550,500
 );
 expect(result.status).toBe('ocr-unverified');
 expect(result.currentWithinConfiguredLimit).toBe(false);
 expect(result.nextEligible).toMatchObject({
  localDate:'2026-10-17',localTime:'21:30',pricePer1000:450,
  savingVsCurrentPer1000:170,savingVsCurrentPercent:27.4
 });
 expect(result.cheapestEligible?.pricePer1000).toBe(380);
 expect(result.purchaseAuthorized).toBe(false);
 expect(result.requiresLiveConfirmation).toBe(true);
});

test('teto inclusivo e virada de dia sem confundir fuso horario',()=>{
 const result=fuelPriceWindow(
  new Date('2026-10-18T01:30:00Z'),
  calendar([day(17,[[1200,800]]),day(18,[[0,500],[30,510]])]),
  550,550,500
 );
 expect(result.nextEligible).toMatchObject({
  localDate:'2026-10-18',localTime:'00:00',pricePer1000:500,belowConfiguredBy:50
 });
 expect(result.nextEligible?.atUtc).toBe('2026-10-18T03:00:00.000Z');
});

test('preco live ja elegivel nao e substituido por previsao',()=>{
 const result=fuelPriceWindow(
  new Date('2026-10-17T23:45:00Z'),calendar([day(17,[[1290,430]])]),
  480,550,500
 );
 expect(result.currentWithinEffectiveLimit).toBe(true);
 expect(result.nextEligible?.savingVsCurrentPer1000).toBe(50);
 expect(result.purchaseAuthorized).toBe(false);
});

test('nao extrapola preco para mes seguinte',()=>{
 const result=fuelPriceWindow(
  new Date('2026-11-01T02:50:00Z'),
  calendar([day(31,[[1320,700]])]),
  700,550,550
 );
 expect(result.nextEligible).toBeNull();
});

test('nao anuncia slots malformados ou acima do limite efetivo',()=>{
 const result=fuelPriceWindow(
  new Date('2026-10-17T23:45:00Z'),
  calendar([day(17,[[1290,550],[1320,510]])]),590,550,500
 );
 expect(result.nextEligible).toBeNull();
 const malformed=fuelPriceWindow(
  new Date('2026-10-17T23:45:00Z'),
  calendar([day(17,[[1320,400],[1290,380]])]),590,550,500
 );
 expect(malformed.status).toBe('unavailable');
 expect(malformed.nextEligible).toBeNull();
});
