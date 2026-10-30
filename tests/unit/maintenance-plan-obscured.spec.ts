import { test, expect, type Page } from '@playwright/test';
import { MaintenanceUtils, parseMaintenanceHoursToCheck, maintenanceCheckVerificationStatus, scopedMaintenanceBulkCheckCards } from '../../utils/maintenance.utils';

test('remaining maintenance hours require one explicit Hours to check field',()=>{
  expect(parseMaintenanceHoursToCheck('Registration: 001-A\nFlight hours\n10,443\nHours to check\n0\nWear 14%')).toBe(0);
  expect(parseMaintenanceHoursToCheck('Flight hours 1399\nHours to check: 20\nWear 11%')).toBe(20);
  expect(parseMaintenanceHoursToCheck('Flight hours 190\nRegistration 001-A')).toBe(null);
  expect(parseMaintenanceHoursToCheck('Plane 0; hour 5\nMaintenance required')).toBe(null);
  expect(parseMaintenanceHoursToCheck('Hours to check: 4\nHours to check: 10')).toBe(null);
  expect(parseMaintenanceHoursToCheck('Hours to check: 4.5')).toBe(null);
  expect(parseMaintenanceHoursToCheck('Hours to check: -1')).toBe(null);
  expect(parseMaintenanceHoursToCheck('Hours to check: 99999999')).toBe(null);
  expect(parseMaintenanceHoursToCheck('Hours to check: many')).toBe(null);
});

async function fixture(page:Page){
  await page.route('**/*',route=>route.abort());
  await page.setContent(`<button id="plan" style="position:fixed;top:80px;left:60px;width:140px;height:60px;z-index:1"> Plan</button>
  <div id="blocker" style="position:fixed;inset:0;background:rgba(0,0,0,.5);z-index:999"></div>
  <script>window.navigationClicks=0;window.serviceClicks=0;
  document.getElementById('plan').addEventListener('click',()=>window.navigationClicks++);</script>`);
}

test('obscured Plan can recover navigation once before any maintenance service',async({page})=>{
  await fixture(page);
  let recoveries=0;
  const util=new MaintenanceUtils(page);
  await util.openPlanPanel(async()=>{
    recoveries++;
    await page.locator('#blocker').evaluate(el=>el.remove());
  });
  expect(recoveries).toBe(1);
  expect(await page.evaluate(()=>(window as any).navigationClicks)).toBe(1);
  expect(await page.evaluate(()=>(window as any).serviceClicks)).toBe(0);
});

test('persistent blocker fails closed without a second recovery or service click',async({page})=>{
  await fixture(page);
  let recoveries=0;
  const util=new MaintenanceUtils(page);
  await expect(util.openPlanPanel(async()=>{recoveries++;})).rejects.toThrow('UI_CONTROL_OBSCURED');
  expect(recoveries).toBe(1);
  expect(await page.evaluate(()=>(window as any).navigationClicks)).toBe(0);
  expect(await page.evaluate(()=>(window as any).serviceClicks)).toBe(0);
});

test('maintenance repair navigation never retries without explicit first-stage callback',async({page})=>{
  await fixture(page);
  const util=new MaintenanceUtils(page);
  await expect(util.openPlanPanel()).rejects.toThrow('UI_CONTROL_OBSCURED');
  expect(await page.evaluate(()=>(window as any).navigationClicks)).toBe(0);
  expect(await page.evaluate(()=>(window as any).serviceClicks)).toBe(0);
});

test('challenge blocks plan-recovery callback and all interaction',async({page})=>{
  await fixture(page);
  await page.setContent(`<title>Security Check</title><button> Plan</button><div>Verify you are human</div>`);
  let recoveries=0;
  const util=new MaintenanceUtils(page);
  await expect(util.openPlanPanel(async()=>{recoveries++;})).rejects.toThrow('INTERACTIVE_CHALLENGE_DETECTED_STOP');
  expect(recoveries).toBe(0);
});


test('real #960 scenario cannot be reported as completed when one of 33 card hours was not verified',()=>{
  expect(maintenanceCheckVerificationStatus({evaluated:33,unverified:1})).toBe('unverified');
  expect(maintenanceCheckVerificationStatus({evaluated:33,unverified:0})).toBe('completed_observed');
  expect(maintenanceCheckVerificationStatus({evaluated:0,unverified:0})).toBe('unverified');
  expect(maintenanceCheckVerificationStatus({evaluated:33,unverified:-1})).toBe('unverified');
  expect(maintenanceCheckVerificationStatus({evaluated:33,unverified:Number.NaN})).toBe('unverified');
});


test('run #1230 regression: native maintenance panel excludes unrelated bg-white card 0',async({page})=>{
  await page.setContent(`
    <div class="bg-white" id="background-header">Dashboard header without maintenance data</div>
    <div id="routeAction"><div class="bg-white">Unrelated Fleet card</div></div>
    <div id="maintAction">
      <div class="bg-white" id="maintenance-1">Aircraft 1 Hours to check: 25</div>
      <div class="bg-white" id="maintenance-2">Aircraft 2 Hours to check: 12</div>
    </div>
  `);
  const cards=scopedMaintenanceBulkCheckCards(page);
  expect(await page.locator('.bg-white').count()).toBe(4);
  expect(await cards.count()).toBe(2);
  expect(await cards.nth(0).getAttribute('id')).toBe('maintenance-1');
  expect(await cards.nth(1).getAttribute('id')).toBe('maintenance-2');
  expect((await cards.allInnerTexts()).map(parseMaintenanceHoursToCheck)).toEqual([25,12]);
});

test('maintenance scope fails closed: background Fleet cards alone are never service targets',async({page})=>{
  await page.setContent('<div class="bg-white">Hours to check: 0</div><div id="routeAction" class="bg-white">Hours to check: 0</div>');
  expect(await scopedMaintenanceBulkCheckCards(page).count()).toBe(0);
});
