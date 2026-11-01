import {test,expect,type Page} from '@playwright/test';
import type {AircraftSnapshot,CollectionResult} from '../../demand/types';
import type {AirportCatalog} from '../../optimization/reference-data';
import {
  selectVerifiedRollingFuelTarget,readVerifiedRollingCurrentRouteFuel,restoreRollingFuelFirstPage
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


/** Fake DOM includes only native-navigation callbacks. There are never live
 * credentials, endpoint calls, route mutations, or Depart clicks. */
async function quoteRestoreFixture(page:Page,variant:'already-open'|'reopen'|'no-back'|'stuck-back'){
  await page.route('**/*',r=>r.abort());
  await page.setContent(`
    <button id="mapRoutes" onclick="hideAllWhenClick();menuFleet('Routes');">Fleet</button>
    <div id="routeAction" style="display:${variant==='already-open'?'block':'none'}"></div>
    <div id="newRouteInfo">
      ${variant==='no-back'?'<span>Current route quote</span>':`<button id="native-back" onclick="goBack()">Back</button>`}
    </div>
    <script>
      window.departClicks=0;window.fleetClicks=0;window.backClicks=0;
      window.hideAllWhenClick=function(){};
      window.makeFleet=function(){
        document.getElementById('routeAction').innerHTML=
          '<div id="routesContainer"><button>Routes (1)</button>'+
          '<div id="routeMainList37181887" class="row classPAX listDepartable">'+
          '<a onclick="playSound(\\'neutral_click\\');Ajax(\\'fleet_details.php?id=24701144\\',\\'detailsAction\\');if(intro==0){$(\\'#routeAction\\').hide();}">'+
          '<span id="acRegList24701144">PP-194</span> - aircraft</a>'+
          '<button id="listDepart37181887" onclick="window.departClicks++">Depart</button></div></div>';
        document.getElementById('routeAction').style.display='block';
      };
      window.menuFleet=function(){window.fleetClicks++;window.makeFleet();};
      window.goBack=function(){
        window.backClicks++;
        if('${variant}'!=='stuck-back'){
          document.getElementById('newRouteInfo').style.display='none';
          if('${variant}'==='already-open')window.makeFleet();
        }
      };
    </script>
  `);
}

test('run #1318: native Back restores a verified first page; never presses Depart',async({page})=>{
  await quoteRestoreFixture(page,'already-open');
  await restoreRollingFuelFirstPage(page,1500);
  const outcome=await page.evaluate(()=>({
    back:(window as any).backClicks,fleet:(window as any).fleetClicks,
    departed:(window as any).departClicks
  }));
  expect(outcome).toEqual({back:1,fleet:0,departed:0});
  expect(await page.locator('#routeAction').isVisible()).toBe(true);
  expect(await page.locator('#newRouteInfo').isVisible()).toBe(false);
});

test('run #1318: quote Back followed by one native Fleet opening restores hidden page',async({page})=>{
  await quoteRestoreFixture(page,'reopen');
  await restoreRollingFuelFirstPage(page,1500);
  expect(await page.evaluate(()=>({
    back:(window as any).backClicks,fleet:(window as any).fleetClicks,
    departed:(window as any).departClicks
  }))).toEqual({back:1,fleet:1,departed:0});
});

test('quote restore fails closed when native Back is absent or did not close overlay',async({page})=>{
  for(const variant of ['no-back','stuck-back'] as const){
    await quoteRestoreFixture(page,variant);
    await expect(restoreRollingFuelFirstPage(page,1500)).rejects.toThrow(
      variant==='no-back'?'ROLLING_FUEL_NATIVE_BACK_UNVERIFIED':'ROLLING_FUEL_QUOTE_NOT_CLOSED');
    expect(await page.evaluate(()=>(window as any).departClicks)).toBe(0);
    expect(await page.evaluate(()=>(window as any).fleetClicks)).toBe(0);
  }
});
