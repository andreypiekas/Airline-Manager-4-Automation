import { test, expect, type Page } from '@playwright/test';
import { MaintenanceUtils, parseMaintenanceHoursToCheck } from '../../utils/maintenance.utils';

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
