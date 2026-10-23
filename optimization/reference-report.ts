import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { CollectionResult } from '../demand/types';
import { OptimizationConfig } from './report';
import { resolveAircraftOrigin } from './aircraft-origins';
import { calendarReference, FuelCalendar, loadReference, RouteCatalog, AirportCatalog, shortlistRoutes } from './reference-data';
import { communityRoutePriceScenarios } from './community-route-prices';
import { discoverCatalogForFleet, type CatalogDiscoveryReport } from './reference-discovery';

export async function writeReferenceReport(collection: CollectionResult, config: OptimizationConfig, directory='test-results/demand', now=new Date()) {
  let routes:unknown[]=[];
  const warnings:string[]=[];
  const origins=new Map(collection.aircraft.map(a=>[
    a.aircraftId,resolveAircraftOrigin(a,collection,config.aircraftOrigins,config.airlineBases).origin
  ] as const));
  let catalog:RouteCatalog|null=null,airports:AirportCatalog|null=null;
  try {
    const loaded=await loadReference<RouteCatalog>('routes.json');
    if(loaded.schemaVersion!==1||!Array.isArray(loaded.routes)||!loaded.source||!loaded.sha256)throw new Error();
    catalog=loaded;
    routes=collection.aircraft.map(a=>({aircraftId:a.aircraftId,registration:a.registration,
      candidates:collection.complete?shortlistRoutes(a,origins.get(a.aircraftId)||null,loaded)
        .map(candidate=>({...candidate,
          communityPriceScenarios:communityRoutePriceScenarios(candidate.distanceKm,a.capacity,candidate.referenceDemand)})):[]}));
  } catch {warnings.push('ROUTE_REFERENCE_UNAVAILABLE');}
  try {
    const loaded=await loadReference<AirportCatalog>('airports.json');
    if(![1,2].includes(loaded.schemaVersion)||!Array.isArray(loaded.airports)||!loaded.license||!loaded.source)throw new Error();
    airports=loaded;
  } catch {warnings.push('AIRPORT_REFERENCE_UNAVAILABLE');}

  // Full scan of the CURATED source independent of native suggestions; never a global search.
  // Unknown or conflicting runway data, aircraft, or coverage does not produce candidates.
  let catalogDiscovery:CatalogDiscoveryReport|null=null;
  if(catalog){
    catalogDiscovery=discoverCatalogForFleet(
      collection,origins,catalog,airports,config.airlineBases,now,config.maxAgeSeconds,20
    );
  }

  let fuel:unknown={status:'unsupported-month'},co2:unknown={status:'unsupported-month'};
  try {
    const local=new Date(now.getTime()-180*60000);
    const days=new Date(Date.UTC(local.getUTCFullYear(),local.getUTCMonth()+1,0)).getUTCDate();
    if(days===30||days===31){
      const calendar=await loadReference<FuelCalendar>(days===30?'fuel-calendar-30.json':'fuel-calendar-31.json');
      fuel=calendarReference(now,calendar,'fuel');co2=calendarReference(now,calendar,'co2');
    }
  } catch {warnings.push('FUEL_REFERENCE_UNAVAILABLE');}
  const report={schemaVersion:1,generatedAt:now.toISOString(),dryRun:true,mutationAuthorized:false,
    referenceOnly:true,routes,catalogDiscovery,fuel,co2,warnings:[...warnings,...(catalogDiscovery?.warnings||[])]};
  await mkdir(directory,{recursive:true});
  await writeFile(join(directory,'reference-report.json'),JSON.stringify(report,null,2)+'\n');

  const overview=catalogDiscovery?[
    '# Cobertura e pesquisa independente do catalogo AM4','',
    `Fonte: ${catalogDiscovery.source}; registros: ${catalogDiscovery.referenceRows}.`,
    'O catalogo e curado e incompleto. Zero candidatos nao comprova inexistencia de rotas lucrativas.',
    'Valores sao tetos brutos hipoteticos por uma partida, nao lucro, demanda restante nem decisao de reroute.','',
    '## Bases representadas','',
    ...catalogDiscovery.coverage.map(c=>`- ${c.origin}: ${c.listedRows} registros, ${c.distinctDestinations} destinos distintos conhecidos. Outros destinos nao foram avaliados.`),
    '','## Aeronaves','',
    ...catalogDiscovery.aircraft.flatMap(a=>[
      `- ${a.aircraftId} (${a.registration}) origem ${a.origin||'indisponivel'}: ${a.status}; examinados ${a.examinedRows}; elegiveis no catalogo ${a.eligibleRowsBeforeLimit}.`,
      ...a.ranked.map((c,i)=>`  - #${i+1} ${c.from}–${c.to}: ${c.distanceKm} km; cobertura estatica de assentos ${c.referenceSeatCoveragePercent.toFixed(1)}%; menor teto bruto teorico entre Easy e Realism $ ${c.minTheoreticalGrossAcrossModes.toFixed(0)}; rota atual mesmo par ${c.sameAirportPairAsCurrentRoute?'sim':'nao'}.`)
    ]),
    '','Nao altera pricing, KEEP/HOLD/REROUTE, compras nem decolagens.',''
  ]:['# Pesquisa do catalogo indisponivel','','Nenhuma conclusao sobre melhores rotas pode ser feita.',''];
  await writeFile(join(directory,'catalog-discovery.md'),overview.join('\n'));
  return report;
}
