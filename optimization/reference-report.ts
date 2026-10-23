import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { CollectionResult } from '../demand/types';
import { OptimizationConfig } from './report';
import { resolveAircraftOrigin } from './aircraft-origins';
import { calendarReference, FuelCalendar, loadReference, RouteCatalog, shortlistRoutes } from './reference-data';
import { communityRoutePriceScenarios } from './community-route-prices';
export async function writeReferenceReport(collection: CollectionResult, config: OptimizationConfig, directory='test-results/demand', now=new Date()) {
  let routes: unknown[]=[];const warnings:string[]=[];
  try {
    const catalog=await loadReference<RouteCatalog>('routes.json');
    if(catalog.schemaVersion!==1 || !Array.isArray(catalog.routes)) throw new Error();
    routes=collection.aircraft.map(a=>({aircraftId:a.aircraftId,registration:a.registration,
      candidates:collection.complete?shortlistRoutes(a,resolveAircraftOrigin(a,collection,config.aircraftOrigins,config.airlineBases).origin,catalog)
        .map(candidate=>({...candidate,communityPriceScenarios:communityRoutePriceScenarios(candidate.distanceKm,a.capacity,candidate.referenceDemand)})):[]}));
  } catch {warnings.push('ROUTE_REFERENCE_UNAVAILABLE');}
  let fuel:unknown={status:'unsupported-month'},co2:unknown={status:'unsupported-month'};
  try {
    const local=new Date(now.getTime()-180*60000);const days=new Date(Date.UTC(local.getUTCFullYear(),local.getUTCMonth()+1,0)).getUTCDate();
    if(days===30||days===31){const calendar=await loadReference<FuelCalendar>(days===30?'fuel-calendar-30.json':'fuel-calendar-31.json');fuel=calendarReference(now,calendar,'fuel');co2=calendarReference(now,calendar,'co2');}
  } catch {warnings.push('FUEL_REFERENCE_UNAVAILABLE');}
  const report={schemaVersion:1,generatedAt:now.toISOString(),dryRun:true,mutationAuthorized:false,referenceOnly:true,routes,fuel,co2,warnings};
  await mkdir(directory,{recursive:true});await writeFile(join(directory,'reference-report.json'),JSON.stringify(report,null,2)+'\n');return report;
}
