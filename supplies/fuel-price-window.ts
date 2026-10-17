import type {FuelCalendar, CalendarDay} from '../optimization/reference-data';

/** Calendario e apenas referencia: nenhuma previsao autoriza a compra. */
export interface FuelPriceSlot {
  atUtc:string;
  localDate:string;
  localTime:string;
  pricePer1000:number;
  savingVsCurrentPer1000:number|null;
  savingVsCurrentPercent:number|null;
  belowConfiguredBy:number;
}
export interface FuelPriceWindow {
  status:'reference-only'|'ocr-unverified'|'unavailable';
  checkedAt:string;
  timezone:'UTC-03:00';
  horizonHours:24;
  configuredMax:number;
  effectiveMax:number;
  currentPricePer1000:number|null;
  currentWithinConfiguredLimit:boolean|null;
  currentWithinEffectiveLimit:boolean|null;
  nextEligible:FuelPriceSlot|null;
  cheapestEligible:FuelPriceSlot|null;
  purchaseAuthorized:false;
  requiresLiveConfirmation:true;
  note:string;
}
const validPrice=(n:unknown):n is number=>Number.isSafeInteger(n)&&Number(n)>0;
const pad=(n:number)=>String(n).padStart(2,'0');
const validRows=(day:CalendarDay)=>Array.isArray(day.fuel)&&!day.fuelIssues&&day.fuel.every((row,index)=>
  Array.isArray(row)&&row.length===2&&Number.isSafeInteger(row[0])&&row[0]>=0&&row[0]<1440&&
  validPrice(row[1])&&(index===0||day.fuel[index-1][0]<row[0]));

/** Busca a proxima cotacao de referencia <= teto efetivo nas 24h seguintes (UTC-3).
 * Nao extrapola o calendario a outro mes nem inventa precos entre slots listados.
 */
export function fuelPriceWindow(
  now:Date,calendar:FuelCalendar,currentPrice:number|null,configuredMax:number,effectiveMax:number
):FuelPriceWindow {
  const validCurrent=validPrice(currentPrice);
  const current=validCurrent?currentPrice:null;
  const base:FuelPriceWindow={
    status:'unavailable',checkedAt:Number.isFinite(now.getTime())?now.toISOString():'invalid',
    timezone:'UTC-03:00',horizonHours:24,configuredMax,effectiveMax,
    currentPricePer1000:current,
    currentWithinConfiguredLimit:current===null?null:current<=configuredMax,
    currentWithinEffectiveLimit:current===null?null:current<=effectiveMax,
    nextEligible:null,cheapestEligible:null,purchaseAuthorized:false,requiresLiveConfirmation:true,
    note:'Sem cotacoes futuras confiaveis; revalidar o preco ao vivo antes de comprar.'
  };
  if(!Number.isFinite(now.getTime())||!calendar||calendar.utcOffsetMinutes!==-180||
    ![30,31].includes(calendar.monthLength)||!Array.isArray(calendar.days)||
    !validPrice(configuredMax)||!validPrice(effectiveMax)||effectiveMax>configuredMax)return base;
  const shifted=new Date(now.getTime()-180*60000);
  const year=shifted.getUTCFullYear(),month=shifted.getUTCMonth();
  if(new Date(Date.UTC(year,month+1,0)).getUTCDate()!==calendar.monthLength)return base;
  const slots:Array<{epoch:number;day:CalendarDay;minute:number;price:number}>=[];
  let inspected=0,unverified=false;
  for(let offset=0;offset<=1;offset++){
    const localDate=new Date(Date.UTC(year,month,shifted.getUTCDate()+offset));
    // Nao presume que precos se repetem no proximo mes.
    if(localDate.getUTCMonth()!==month)continue;
    const day=calendar.days.find(d=>d.day===localDate.getUTCDate());
    if(!day||!validRows(day))continue;
    inspected++;
    if(!day.verified||calendar.status==='ocr-unverified')unverified=true;
    for(const [minute,price] of day.fuel){
      const epoch=Date.UTC(year,month,localDate.getUTCDate(),0,minute)+180*60000;
      if(epoch>now.getTime()&&epoch<=now.getTime()+24*3600000&&price<=effectiveMax)
        slots.push({epoch,day,minute,price});
    }
  }
  if(!inspected)return base;
  slots.sort((a,b)=>a.epoch-b.epoch);
  const toSlot=(slot:typeof slots[number]):FuelPriceSlot=>{
    const localDate=new Date(slot.epoch-180*60000);
    return {
      atUtc:new Date(slot.epoch).toISOString(),
      localDate:localDate.getUTCFullYear()+'-'+pad(localDate.getUTCMonth()+1)+'-'+pad(localDate.getUTCDate()),
      localTime:pad(Math.floor(slot.minute/60))+':'+pad(slot.minute%60),
      pricePer1000:slot.price,
      savingVsCurrentPer1000:current===null?null:current-slot.price,
      savingVsCurrentPercent:current===null?null:Math.round((current-slot.price)*1000/current)/10,
      belowConfiguredBy:configuredMax-slot.price
    };
  };
  const cheapest=[...slots].sort((a,b)=>a.price-b.price||a.epoch-b.epoch)[0]||null;
  return {...base,
    status:unverified?'ocr-unverified':'reference-only',
    nextEligible:slots[0]?toSlot(slots[0]):null,
    cheapestEligible:cheapest?toSlot(cheapest):null,
    note:unverified
      ?'HORARIO E PRECO NAO VERIFICADOS (OCR). So o preco live pode autorizar uma compra.'
      :'Referencia historica: horario/preco nao garantidos. Confirmar ao vivo antes de comprar.'
  };
}
