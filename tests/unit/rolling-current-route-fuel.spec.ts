import {test,expect,type Page} from '@playwright/test';
import type {AircraftSnapshot,CollectionResult} from '../../demand/types';
import type {AirportCatalog} from '../../optimization/reference-data';
import {
  selectVerifiedRollingFuelTarget,readVerifiedRollingCurrentRouteFuel
} from '../../optimization/individual-current-route-fuel';

const ready=():AircraftSnapshot=>({
  aircraftId:'24701144',routeId:'37181887',registration:'PP-194',
  routeLabel:'IPC - ASB',from:'IPC',to:'ASB',state:'ready',
  capacity:{Y:100,J:0,F:0},remaining:{Y:90,J:0,F:0},
  dailyTotal:{Y:100,J:0,F:0},observedAt:new Date().toISOString()
});
const window=(aircraft:AircraftSnapshot[]=[ready()]):CollectionResult=>({
  aircraft,complete:false,expectedRoutes:178,
  observationScope:'native-individual-first-page',
  windowReadyCandidates:aircraft.length,warnings:[]
});

test('run #1315 PP-194 can request a read-only quote without fabricating complete fleet',()=>{
  const a=ready(),collection=window([a]);
  expect(selectVerifiedRollingFuelTarget(collection,a)).toEqual(a);
  expect(collection.complete).toBe(false);
  expect(collection.expectedRoutes).toBe(178);
});

test('rolling fuel target rejects missing provenance, changed identity and wrong direction',()=>{
  const a=ready(),collection=window([a]);
  for(const changed of [
    {...a,aircraftId:'24701145'},{...a,routeId:'37181888'},
    {...a,registration:'PP-OTHER'},{...a,from:'ASB',to:'IPC'},
    {...a,state:'inflight' as const},{...a,issue:'UNVERIFIED'}
  ])expect(selectVerifiedRollingFuelTarget(collection,changed)).toBeNull();
  for(const invalid of [
    {...collection,complete:true},
    {...collection,observationScope:undefined},
    {...collection,windowReadyCandidates:0},
    {...collection,expectedRoutes:0},
    {...collection,expectedRoutes:null},
    {...collection,aircraft:[]},
    {...collection,aircraft:[a,{...a,aircraftId:'24701145'}]},
    {...collection,aircraft:[a,{...a,routeId:'37181888'}]},
    {...collection,aircraft:[{...a,issue:'UNVERIFIED'}]},
    {...collection,aircraft:[{...a,capacity:null}]}
  ] as CollectionResult[])expect(selectVerifiedRollingFuelTarget(invalid,a)).toBeNull();
  expect(selectVerifiedRollingFuelTarget(null,a)).toBeNull();
});

test('missing or ambiguous destination source IDs hold before touching browser',async()=>{
  let browserTouched=false;
  const page={locator:()=>{browserTouched=true;throw Error('UNEXPECTED_UI_ACCESS');}} as unknown as Page;
  const catalog=(sourceIds:number[],runwayFt=5000):AirportCatalog=>({
    schemaVersion:2,airports:[{iata:'ASB',sourceIds,runwayFt}]
  } as unknown as AirportCatalog);
  const a=ready();
  expect(await readVerifiedRollingCurrentRouteFuel(page,a,catalog([]),178)).toBeNull();
  expect(await readVerifiedRollingCurrentRouteFuel(page,a,catalog([1,2]),178)).toBeNull();
  expect(await readVerifiedRollingCurrentRouteFuel(page,a,catalog([1],0),178)).toBeNull();
  expect(await readVerifiedRollingCurrentRouteFuel(page,a,catalog([1]),0)).toBeNull();
  expect(browserTouched).toBe(false);
});
