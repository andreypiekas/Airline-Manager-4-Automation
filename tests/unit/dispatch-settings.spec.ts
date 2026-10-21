import { test,expect } from '@playwright/test';
import { readFile,mkdtemp,rm } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const {resolveDepartureSettings}=require('../../scripts/resolve-departure-settings.cjs');
test('exact reported repository configuration activates real mode and keeps its one-flight limit',()=>{
 expect(resolveDepartureSettings({AM4_INPUT_EXECUTE:'false',AM4_INPUT_MAX_DEPARTURES:'0',AM4_REPOSITORY_EXECUTE:'true',AM4_REPOSITORY_MAX_DEPARTURES:'1'})).toMatchObject({dryRun:false,maxDepartures:1,modeSource:'variable:EXECUTE_INDIVIDUAL'});
});
test('absent settings default to simulation and one-flight limit',()=>expect(resolveDepartureSettings({})).toMatchObject({dryRun:true,maxDepartures:1,automationMode:'simulation',semiAutomatic:false,semiConfirmed:false}));
test('cron with no new inputs inherits the repository activation and limit',()=>expect(resolveDepartureSettings({AM4_REPOSITORY_EXECUTE:'true',AM4_REPOSITORY_MAX_DEPARTURES:'3'})).toMatchObject({dryRun:false,maxDepartures:3}));
test('default zero input does not shadow the repository limit',()=>expect(resolveDepartureSettings({AM4_INPUT_MAX_DEPARTURES:'0',AM4_REPOSITORY_MAX_DEPARTURES:'4'}).maxDepartures).toBe(4));
test('GitHub numeric zero-point-zero input uses repository limit without weakening integer validation',()=>{
 expect(resolveDepartureSettings({AM4_INPUT_MAX_DEPARTURES:'0.0',AM4_REPOSITORY_MAX_DEPARTURES:'20'})).toMatchObject({maxDepartures:20,limitSource:'variable:MAX_INDIVIDUAL_DEPARTURES'});
 expect(resolveDepartureSettings({AM4_INPUT_MAX_DEPARTURES:'2.0',AM4_REPOSITORY_MAX_DEPARTURES:'4'})).toMatchObject({maxDepartures:2,limitSource:'input:limit'});
 expect(()=>resolveDepartureSettings({AM4_INPUT_MAX_DEPARTURES:'1.5'})).toThrow();
 expect(()=>resolveDepartureSettings({AM4_INPUT_MAX_DEPARTURES:'1e1'})).toThrow();
});
test('explicit positive input overrides repository limit',()=>expect(resolveDepartureSettings({AM4_INPUT_MAX_DEPARTURES:'2',AM4_REPOSITORY_MAX_DEPARTURES:'4'}).maxDepartures).toBe(2));
test('repository zero limit falls back to safe default one',()=>expect(resolveDepartureSettings({AM4_REPOSITORY_MAX_DEPARTURES:'0'})).toMatchObject({maxDepartures:1,limitSource:'default:1'}));
test('simulation override prevents operations even with both activation switches true',()=>expect(resolveDepartureSettings({AM4_INPUT_MODE:'simulation',AM4_INPUT_EXECUTE:'true',AM4_REPOSITORY_EXECUTE:'true'}).dryRun).toBe(true));
test('production input is explicit activation',()=>expect(resolveDepartureSettings({AM4_INPUT_MODE:'production',AM4_REPOSITORY_EXECUTE:'false'}).dryRun).toBe(false));
test('legacy activation input still works',()=>expect(resolveDepartureSettings({AM4_INPUT_EXECUTE:'true',AM4_REPOSITORY_EXECUTE:'false'}).dryRun).toBe(false));
test('semi-automatic variable forces analysis-only even when production was requested',()=>{
 expect(resolveDepartureSettings({
  AM4_INPUT_MODE:'production',AM4_REPOSITORY_EXECUTE:'true',AM4_SEMI_AUTOMATIC:'true',AM4_SEMI_CONFIRM:'false'
 })).toMatchObject({dryRun:true,automationMode:'semi-automatic',semiAutomatic:true,semiConfirmed:false,modeSource:'variable:SEMI_AUTOMATIC_MODE'});
});
test('semi-automatic production requires explicit confirmation for that run',()=>{
 expect(resolveDepartureSettings({
  AM4_INPUT_MODE:'production',AM4_REPOSITORY_EXECUTE:'true',AM4_SEMI_AUTOMATIC:'true',AM4_SEMI_CONFIRM:'true'
 })).toMatchObject({dryRun:false,automationMode:'production',semiAutomatic:true,semiConfirmed:true,modeSource:'input:confirm_semiautomatic_execution'});
});

for(const [index,env] of [{AM4_INPUT_MODE:'automatic'},{AM4_REPOSITORY_EXECUTE:'tru'},{AM4_INPUT_EXECUTE:'yes'},{AM4_SEMI_AUTOMATIC:'yes'},{AM4_SEMI_CONFIRM:'1'},{AM4_INPUT_MAX_DEPARTURES:'-1'},{AM4_INPUT_MAX_DEPARTURES:'101'},{AM4_INPUT_MAX_DEPARTURES:'1.5'},{AM4_REPOSITORY_MAX_DEPARTURES:'1\nother=secret'}].entries())
 test(`invalid settings fail before any game login case ${index}`,()=>expect(()=>resolveDepartureSettings(env)).toThrow());
test('both workflows wire repository variables into the shared resolver and use its outputs',async()=>{
 for(const name of ['playwright.yml','individual-departures.yml']){
  const s=await readFile('.github/workflows/'+name,'utf8');expect(s).toContain("AM4_REPOSITORY_EXECUTE: ${{ vars.EXECUTE_INDIVIDUAL || 'true' }}");expect(s).toContain("AM4_REPOSITORY_MAX_DEPARTURES: ${{ vars.MAX_INDIVIDUAL_DEPARTURES || '20' }}");expect(s).toContain("AM4_DISPATCH_ALL_READY: ${{ vars.DISPATCH_ALL_READY || 'true' }}");expect(s).toContain("AM4_SEMI_AUTOMATIC: ${{ vars.SEMI_AUTOMATIC_MODE || 'false' }}");expect(s).toContain('AM4_SEMI_CONFIRM: ${{ inputs.confirm_semiautomatic_execution');expect(s).toContain('DEMAND_DRY_RUN: ${{ steps.departure_settings.outputs.dry_run }}');expect(s).toContain('DEMAND_MAX_DEPARTURES_PER_RUN: ${{ steps.departure_settings.outputs.max_departures }}');expect(s).toContain('group: airline-manager-4-main');expect(s).not.toContain('\n  push:');
 }
});
test('resolver CLI produces safe Action outputs and explicit operational-mode log without credentials',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'am4-dispatch-'));const target=join(dir,'output');
 try{const log=execFileSync(process.execPath,['scripts/resolve-departure-settings.cjs'],{env:{GITHUB_OUTPUT:target,AM4_REPOSITORY_EXECUTE:'true',AM4_REPOSITORY_MAX_DEPARTURES:'1'},encoding:'utf8'});expect(await readFile(target,'utf8')).toBe('dry_run=false\nmax_departures=1\nautomation_mode=production\nsemi_automatic=false\nsemi_confirmed=false\n');expect(log).toContain('"dryRun":false');expect(log).toContain('variable:EXECUTE_INDIVIDUAL');}finally{await rm(dir,{recursive:true,force:true});}
});

test('semi-automatic workflow disables all game mutations until manual confirmation',async()=>{
 const s=await readFile('.github/workflows/playwright.yml','utf8');
 expect(s).toContain('confirm_semiautomatic_execution:');
 expect(s).toContain("AM4_SEMI_AUTOMATIC: ${{ vars.SEMI_AUTOMATIC_MODE || 'false' }}");
 for(const name of ['ENABLE_TICKET_PRICING_EXECUTION','ENABLE_ROUTE_EXECUTION','ENABLE_FUEL','ENABLE_MAINTENANCE','ENABLE_CAMPAIGN','ENABLE_DEPART']){
  expect(s).toContain(name+": ${{ steps.departure_settings.outputs.dry_run == 'true' && 'false'");
 }
 expect(s).not.toContain('aktifkan_random_delay');
});

test('main production workflow forwards the declared departure limit input instead of forcing twenty',async()=>{
 const s=await readFile('.github/workflows/playwright.yml','utf8');
 expect(s).toContain('AM4_INPUT_MAX_DEPARTURES: ${{ inputs.max_individual_departures }}');
 expect(s).not.toContain("AM4_INPUT_MAX_DEPARTURES: '20'");
});

test('all-ready production uses bounded 100 instead of the old 20-flight artificial ceiling',()=>{
 expect(resolveDepartureSettings({
  AM4_INPUT_MODE:'production',AM4_INPUT_MAX_DEPARTURES:'0',AM4_REPOSITORY_MAX_DEPARTURES:'20',
  AM4_DISPATCH_ALL_READY:'true'
 })).toMatchObject({dryRun:false,maxDepartures:100,limitSource:'variable:DISPATCH_ALL_READY'});
 expect(resolveDepartureSettings({
  AM4_INPUT_MODE:'simulation',AM4_REPOSITORY_MAX_DEPARTURES:'20',AM4_DISPATCH_ALL_READY:'true'
 })).toMatchObject({dryRun:true,maxDepartures:20});
 expect(resolveDepartureSettings({
  AM4_INPUT_MODE:'production',AM4_REPOSITORY_MAX_DEPARTURES:'20',AM4_DISPATCH_ALL_READY:'false'
 })).toMatchObject({dryRun:false,maxDepartures:20,limitSource:'variable:MAX_INDIVIDUAL_DEPARTURES'});
});
test('explicit manual limit overrides all-ready mode, and 100 is a hard maximum',()=>{
 expect(resolveDepartureSettings({
  AM4_INPUT_MODE:'production',AM4_INPUT_MAX_DEPARTURES:'5',AM4_DISPATCH_ALL_READY:'true'
 })).toMatchObject({maxDepartures:5,limitSource:'input:limit'});
 expect(resolveDepartureSettings({AM4_INPUT_MAX_DEPARTURES:'100'}).maxDepartures).toBe(100);
 expect(()=>resolveDepartureSettings({AM4_INPUT_MAX_DEPARTURES:'101'})).toThrow();
 expect(()=>resolveDepartureSettings({AM4_REPOSITORY_MAX_DEPARTURES:'101'})).toThrow();
 expect(()=>resolveDepartureSettings({AM4_DISPATCH_ALL_READY:'yes'})).toThrow();
});


test('main workflow skips every game-access step when queued SHA is stale',async()=>{
 const s=await readFile('.github/workflows/playwright.yml','utf8');
 expect(s).toContain('name: Verificar SHA atual antes de acessar o jogo');
 expect(s).toContain('git rev-parse refs/remotes/origin/main');
 expect(s).toContain('echo "stale=true" >> "$GITHUB_OUTPUT"');
 expect(s).toContain("if: vars.ENABLE_DEMAND_MANAGER != 'false' && steps.current_head.outputs.stale != 'true'");
 for(const step of ['Garantir estado persistente do repositorio','Restaurar registro persistente de retornos','Resolver modo e limite de decolagens','Executar bot Airline Manager 4']){
  const block=s.slice(s.indexOf('name: '+step),s.indexOf('name: '+step)+900);
  expect(block).toContain("steps.current_head.outputs.stale != 'true'");
 }
});

test('main workflow publishes only the executive dashboard in GITHUB_STEP_SUMMARY',async()=>{
 const s=await readFile('.github/workflows/playwright.yml','utf8');
 const start=s.indexOf('name: Publicar painel executivo');
 const end=s.indexOf('name: Enviar JSON e Markdown de demanda',start);
 expect(start).toBeGreaterThan(-1);expect(end).toBeGreaterThan(start);
 const block=s.slice(start,end);
 expect(block).toContain('company-dashboard.md');
 for(const detailed of ['demand-report.md','route-research.md','candidate-data.md','route-execution.md','pricing-execution.md','optimization-report.md','supply-report.md','execution-report.md'])
  expect(block).not.toContain(detailed);
});
