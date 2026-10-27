import { test,expect,Page } from '@playwright/test';
import { verifiedDepartureHandler,PlaywrightDeparturePort,safeDepartureConfirmReadCode,waitForVerifiedFleetControlReadOnly } from '../../demand/departure-port';
import { executionEnvironment } from '../../demand/execute-run';
import { readDemandConfig } from '../../demand/config';
const handler="$('#panel, .flight-info').hide();hideFlightInfo();$('#routeViewDepart').hide();Ajax('route_depart.php?id=123&ref=list&costIndex=0','target',this);";
test('native handler grammar accepts the inspected individual action only',()=>expect(verifiedDepartureHandler(handler,'123')).toBe(true));
for(const [name,value] of Object.entries({
 comment:'window.mutations++; /* route_depart.php?id=123&ref=list */',
 extraOperation:handler+'buyFuel();',wrongId:handler.replace('id=123','id=124'),
 bulk:handler.replace('route_depart.php','depart_all.php'),
 extraQuery:handler.replace('&ref=list','&token=secret&ref=list'),
 costChange:handler.replace('costIndex=0','costIndex=999'),
 dynamic:handler.replace('costIndex=0','costIndex=\'+value+\''),
 targetCode:handler.replace("'target'","'x');buyAircraft();Ajax('x'"),
 unsafeSelector:handler.replace('#panel, .flight-info','<script>'),
}))test(`rejects handler: ${name}`,()=>expect(verifiedDepartureHandler(value,'123')).toBe(false));
const realEnv={ENABLE_DEMAND_MANAGER:'true',DEMAND_FAIL_SAFE:'true',DEMAND_DRY_RUN:'false',DEMAND_EXECUTION_ACK:'individual-return-legs-v1',GITHUB_ACTIONS:'true',GITHUB_REPOSITORY:'example-user/Airline-Manager-4-Automation',GITHUB_RUN_ID:'123',GITHUB_RUN_ATTEMPT:'1'};
test('real mode needs acknowledgement and a first Actions attempt; analysis still cannot authorize',()=>{
 const config=readDemandConfig(realEnv);expect(config.dryRun).toBe(false);expect(executionEnvironment(config,realEnv)).toEqual({dryRun:false,maxDepartures:1});
});
for(const [key,value] of Object.entries({GITHUB_RUN_ATTEMPT:'2',GITHUB_RUN_ID:'',GITHUB_ACTIONS:'false',GITHUB_REPOSITORY:'invalid-repository',DEMAND_EXECUTION_ACK:'',DEMAND_MAX_DEPARTURES_PER_RUN:'0'}))
 test(`rejects real environment ${key}`,()=>expect(()=>executionEnvironment(readDemandConfig(realEnv),{...realEnv,[key]:value})).toThrow());
test('all-ready runtime permits up to 100 strictly individual departures but rejects 101',()=>{
 const config=readDemandConfig(realEnv);
 expect(executionEnvironment(config,{...realEnv,DEMAND_MAX_DEPARTURES_PER_RUN:'100'}).maxDepartures).toBe(100);
 expect(()=>executionEnvironment(config,{...realEnv,DEMAND_MAX_DEPARTURES_PER_RUN:'101'})).toThrow('DEMAND_EXECUTION_LIMIT_INVALID');
});
test('all-fleet departures use explicit all mode; malformed caps still fail',()=>{
 const cfg=readDemandConfig(realEnv);
 expect(executionEnvironment(cfg,{...realEnv,DEMAND_MAX_DEPARTURES_PER_RUN:'all'}).maxDepartures).toBe('all');
 for(const invalid of ['ALL','unlimited','0','101','3.5','-1'])
  expect(()=>executionEnvironment(cfg,{...realEnv,DEMAND_MAX_DEPARTURES_PER_RUN:invalid})).toThrow('DEMAND_EXECUTION_LIMIT_INVALID');
});
test('cannot select legacy bulk departure with real demand mode',()=>expect(()=>readDemandConfig({...realEnv,ENABLE_DEMAND_MANAGER:'false'})).toThrow());

test('post-click confirmation errors are sanitized without exposing browser details',()=>{
  for(const [message,expected] of [
    ['RESEARCH_LIST_CONTROL_UNVERIFIED','RESEARCH_LIST_CONTROL_UNVERIFIED'],
    ['RESEARCH_PAGINATION_INVALID','RESEARCH_PAGINATION_INVALID'],
    ['locator.waitFor: Timeout 15000ms exceeded; URL https://private.example/?token=DO_NOT_LOG','PLAYWRIGHT_TIMEOUT'],
    ['DOM secret DO_NOT_LOG','UNCLASSIFIED']
  ] as const){
    const code=safeDepartureConfirmReadCode(new Error(message));
    expect(code).toBe(expected);
    expect(code).not.toContain('DO_NOT_LOG');
    expect(code).not.toContain('https://');
  }
  expect(safeDepartureConfirmReadCode(null)).toBe('UNCLASSIFIED');
});

test('post-click Fleet control can reappear after passive polls; no game click',async()=>{
 let polls=0,clicks=0;
 const page={
  locator:(selector:string)=>({
   count:async()=>selector==='#mapRoutes'?1:0,
   isVisible:async()=>true,
   getAttribute:async()=>polls>0?"hideAllWhenClick();menuFleet('Routes');":null,
   click:async()=>{clicks++;}
  }),
  waitForTimeout:async()=>{polls++;}
 } as unknown as Page;
 expect(await waitForVerifiedFleetControlReadOnly(page)).toBe(true);
 expect(polls).toBe(1);
 expect(clicks).toBe(0);
});
test('unverified visible native tab cannot fall back to menu or authorize click',async()=>{
 let clicks=0,polls=0;
 const page={
  locator:(selector:string)=>({
   count:async()=>1,
   isVisible:async()=>true,
   getAttribute:async()=>selector==='#mapRoutes'?"hideAllWhenClick();menuFleet('Routes');":'UNKNOWN_CALLBACK',
   click:async()=>{clicks++;}
  }),
  waitForTimeout:async()=>{polls++;}
 } as unknown as Page;
 expect(await waitForVerifiedFleetControlReadOnly(page,3)).toBe(false);
 expect(polls).toBe(2);
 expect(clicks).toBe(0);
});

test('missing post-click target snapshot logs three read-only retries, no departure click',async()=>{
  let clicks=0;
  const page={
    locator:()=>({
      count:async()=>0,isVisible:async()=>false,
      getAttribute:async()=>null,
      click:async()=>{clicks++;}
    }),
    waitForTimeout:async()=>{}
  } as unknown as Page;
  const port=new PlaywrightDeparturePort(page,1);
  const warnings:string[]=[];
  const original=console.warn;
  try{
    console.warn=(...parts:unknown[])=>{warnings.push(parts.join(' '));};
    const after=await port.confirm({aircraftId:'1',routeId:'2'} as never);
    expect(after).toBeNull();
  }finally{
    console.warn=original;
  }
  expect(clicks).toBe(0);
  expect(warnings.filter(x=>x.startsWith('[DepartureConfirmRead] '))).toEqual([1,2,3].map(attempt=>
    '[DepartureConfirmRead] '+JSON.stringify({attempt,code:'RESEARCH_LIST_CONTROL_UNVERIFIED'})
  ));
  expect(warnings.filter(x=>x.startsWith('[DepartureConfirmControl] '))).toHaveLength(2);
});
