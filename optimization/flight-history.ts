import type { Locator } from '@playwright/test';
import type { Cabins } from '../demand/types';
import { integerText } from '../demand/parsing';

export interface FlightHistoryEntry {
  relativeTime:string;
  from:string;
  to:string;
  registrationLabel:string;
  co2Quotas:number;
  onboard:Cabins;
  fuelLbs:number;
  revenue:number;
}
export interface FlightHistoryEvidence {
  status:'observed'|'unavailable';
  observedAt:string;
  source:'inspected-aircraft-flight-history';
  complete:false;
  entries:FlightHistoryEntry[];
  /** Recalled flight rows excluded explicitly; never fuel evidence or completed flights. */
  excludedRecalledRows?:number;
  navigationDiagnostics?:Array<{tag:string;id:string|null;text:string|null;title:string|null;onclick:string|null;href:string|null;classShape:string|null}>;
  comparisonReady:false;
  mutationAuthorized:false;
}

export function parseFlightHistoryRow(text:string):FlightHistoryEntry|null{
  const normalized=text.replace(/\s+/g,' ').trim();
  const m=normalized.match(/^(.{1,40}? ago) ([A-Z0-9]{3})-([A-Z0-9]{3}) (.{1,80}?) ([\d,]+) Quotas Y(\d+) J(\d+) F(\d+) ([\d,]+) Lbs \$([\d,]+)$/);
  if(!m||m[2]===m[3])return null;
  try{
    const values=[m[5],m[6],m[7],m[8],m[9],m[10]].map(integerText);
    if(values.some(v=>!Number.isSafeInteger(v)||v<0))return null;
    return {
      relativeTime:m[1],from:m[2],to:m[3],registrationLabel:m[4].trim(),
      co2Quotas:values[0],onboard:{Y:values[1],J:values[2],F:values[3]},
      fuelLbs:values[4],revenue:values[5]
    };
  }catch{return null;}
}

/** A recalled flight is NOT evidence of a completed flight or fuel burn.
 * AM4 displays it in the same history table with "Quotas Recalled" and
 * negative revenue or zero-dollar recalled records. Recognize these native formats solely to exclude them
 * while retaining independent, fully parsed real-flight observations.
 * Any other malformed or unrecognized row still invalidates the window. */
export function isRecognizedRecalledFlightHistoryRow(text:string):boolean{
  const normalized=text.replace(/\s+/g,' ').trim();
  const m=normalized.match(/^(.{1,40}? ago) ([A-Z0-9]{3})-([A-Z0-9]{3}) (.{1,80}?) ([\d,]+) Quotas Recalled ([\d,]+) Lbs \$(0|-[\d,]+)$/);
  if(!m||m[2]===m[3]||!m[4].trim())return false;
  try{
    const quotas=integerText(m[5]),fuel=integerText(m[6]);
    // Zero-dollar recalls remain excluded; only negative nonzero refunds are otherwise valid.
    const zeroRevenueRecall=m[7]==='0';
    const refund=zeroRevenueRecall?0:integerText(m[7].slice(1));
    return Number.isSafeInteger(quotas)&&quotas>=0&&
      Number.isSafeInteger(fuel)&&fuel>0&&
      Number.isSafeInteger(refund)&&(zeroRevenueRecall||refund>0);
  }catch{return false;}
}

/**
 * Reads the visible per-aircraft flight history only. It never clicks history
 * controls and does not claim the visible window is a complete accounting log.
 */
export async function readFlightHistoryEvidence(details:Locator):Promise<FlightHistoryEvidence>{
  const base:FlightHistoryEvidence={
    status:'unavailable',observedAt:new Date().toISOString(),source:'inspected-aircraft-flight-history',
    complete:false,entries:[],navigationDiagnostics:[],comparisonReady:false,mutationAuthorized:false
  };
  try{
    const history=details.locator('#flight-history');
    if(await history.count()!==1||!await history.isVisible())return base;
    const controls=history.locator('xpath=..').locator('button,a');
    const controlCount=Math.min(await controls.count(),30);const navigationDiagnostics:FlightHistoryEvidence['navigationDiagnostics']=[];
    for(let i=0;i<controlCount;i++){const x=controls.nth(i);navigationDiagnostics.push({tag:await x.evaluate(el=>el.tagName.toLowerCase()),id:await x.getAttribute('id'),text:(await x.innerText().catch(()=>'' )).replace(/\s+/g,' ').trim().slice(0,120)||null,title:await x.getAttribute('title'),onclick:(await x.getAttribute('onclick'))?.slice(0,300)||null,href:(await x.getAttribute('href'))?.slice(0,300)||null,classShape:(await x.getAttribute('class'))?.replace(/\s+/g,' ').trim().slice(0,200)||null});}
    const rows=history.locator('.row.bg-light.m-text.p-1.border');
    const count=await rows.count();
    if(count<1||count>100)return base;
    const texts=(await rows.allInnerTexts()).map(s=>s.replace(/\s+/g,' ').trim());
    const entries:FlightHistoryEntry[]=[];
    let excludedRecalled=0;
    for(const text of texts){
      const observed=parseFlightHistoryRow(text);
      if(observed){entries.push(observed);continue;}
      if(isRecognizedRecalledFlightHistoryRow(text)){
        // Never count recalled fuel as consumption or an extra sample.
        excludedRecalled++;continue;
      }
      // Unknown format, corrupted values or mismatched row: no fuel evidence.
      return base;
    }
    // A window containing only recalls cannot verify any real fuel consumption.
    if(entries.length===0)return base;
    return {...base,status:'observed',observedAt:new Date().toISOString(),
      entries,navigationDiagnostics,
      ...(excludedRecalled>0?{excludedRecalledRows:excludedRecalled}:{})};
  }catch{return base;}
}
