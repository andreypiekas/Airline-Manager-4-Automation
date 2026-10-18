import type { Cabins } from './types';
import type { FareObservation } from '../pricing/ticket-pricing';

/**
 * Gross ticket revenue ESTIMATE only: observed onboard passengers times the
 * fare read from the verified ticket inputs immediately before departure.
 * Not a Finance-ledger receipt, a profit estimate or a mutation authorization.
 */
export function estimatedGrossTicketRevenue(onboard:Cabins|null|undefined,fares:FareObservation|undefined):number|null {
  if(!onboard||fares?.source!=='inspected-auto-control'||!fares.current||fares.issue)return null;
  let total=0;
  for(const cabin of ['Y','J','F'] as const){
    const passengers=onboard[cabin],price=fares.current[cabin];
    if(!Number.isSafeInteger(passengers)||passengers<0)return null;
    if(!Number.isSafeInteger(price)||price<0)return null;
    if(passengers>0&&price===0)return null;
    const subtotal=passengers*price;
    if(!Number.isSafeInteger(subtotal)||!Number.isSafeInteger(total+subtotal))return null;
    total+=subtotal;
  }
  return total;
}
