import { test, expect, Page } from '@playwright/test';
import { DemandReader } from '../../demand/reader';

/**
 * Regression for live runs #649-651: page 2 repeats exactly the final route
 * of an otherwise complete page 1. Full fleet identity is mandatory.
 * No game endpoint or mutation is used in this fixture.
 */
async function nativeFullBoundaryFixture(page: Page, lastPageSize: number, conflict = false, nonBoundary = false) {
  await page.route('**/*', route => route.abort());
  await page.setContent('<button>Routes (69)</button><div id="routeAction"><div id="routesContainer"></div></div>');
  await page.evaluate(({ lastCount, conflictingAircraft, nonBoundaryRepeat }) => {
    const w = window as any;
    w.pageAdvances = 0;
    w.mutations = 0;
    const pages = [
      Array.from({length:20}, (_, i) => 101 + i),
      Array.from({length:20}, (_, i) => 120 + i),
      Array.from({length:20}, (_, i) => 140 + i),
      Array.from({length:lastCount}, (_, i) => 160 + i)
    ];
    // A native page can repeat a card from the previous page away from the
    // boundary itself, without any read-only authorization to depart.
    if (nonBoundaryRepeat) pages[1] = [121,122,123,124,125,126,117,...Array.from({length:13},(_,i)=>127+i)];
    w.renderNative = (index: number) => {
      const root = document.getElementById('routesContainer')!;
      root.replaceChildren();
      for (const id of pages[index]) {
        const aircraftId = 1000 + id + (conflictingAircraft && index === 1 && id === (nonBoundaryRepeat ? 117 : 120) ? 5000 : 0);
        const row = document.createElement('div');
        row.id = 'routeMainList' + id;
        row.className = 'row classPAX';
        row.innerHTML = '<span class="s-text">AAA - BBB</span>';
        const a = document.createElement('a');
        a.setAttribute('onclick', "playSound('neutral_click');Ajax('fleet_details.php?id=" +
          aircraftId + "','detailsAction');if(intro==0){$('#routeAction').hide();}");
        const registration = document.createElement('span');
        registration.id = 'acRegList' + aircraftId;
        registration.textContent = 'TEST-' + id;
        a.append(registration, ' - test aircraft');
        row.append(a);
        root.append(row);
      }
      if (index < 3) {
        const pager = document.createElement('ul');
        pager.className = 'pagination';
        const next = document.createElement('a');
        next.textContent = 'Next';
        next.href = '#';
        next.setAttribute('onclick', "Ajax('routes.php?start=" +
          ((index + 1) * 20) + "&sort=','routeAction',this);");
        pager.append(next);
        root.append(pager);
      }
    };
    w.Ajax = (target: string) => {
      const match = target.match(/^routes\.php\?start=(\d+)&sort=$/);
      if (match) {
        w.pageAdvances++;
        w.renderNative(Number(match[1]) / 20);
      } else {
        w.mutations++;
      }
    };
    w.renderNative(0);
  }, { lastCount: lastPageSize, conflictingAircraft: conflict, nonBoundaryRepeat: nonBoundary });
}

test('full first page with one verified boundary repeat reconciles all 69 distinct aircraft', async ({page}) => {
  await nativeFullBoundaryFixture(page, 10);
  const r = await new DemandReader(page, 120).collect();
  expect(r.complete).toBe(true);
  expect(r.expectedRoutes).toBe(69);
  expect(r.aircraft).toHaveLength(69);
  expect(new Set(r.aircraft.map(a => a.routeId)).size).toBe(69);
  expect(new Set(r.aircraft.map(a => a.aircraftId)).size).toBe(69);
  expect(await page.evaluate(() => (window as any).pageAdvances)).toBe(3);
  expect(await page.evaluate(() => (window as any).mutations)).toBe(0);
});

test('full first page repeat with only 68 identities remains blocked', async ({page}) => {
  await nativeFullBoundaryFixture(page, 9);
  const r = await new DemandReader(page, 120).collect();
  expect(r.complete).toBe(false);
  expect(r.aircraft).toHaveLength(68);
  expect(r.warnings).toContain('PAGINATION_BOUNDARY_OVERLAP_NOT_RECONCILED');
  expect(await page.evaluate(() => (window as any).mutations)).toBe(0);
});

test('full first page repeat with conflicting aircraft ID never reconciles', async ({page}) => {
  await nativeFullBoundaryFixture(page, 10, true);
  const r = await new DemandReader(page, 120).collect();
  expect(r.complete).toBe(false);
  expect(r.aircraft.length).toBeLessThan(69);
  expect(await page.evaluate(() => (window as any).mutations)).toBe(0);
});

test('single verified interior overlap reconciles all 69 without assuming boundary position', async ({page}) => {
  await nativeFullBoundaryFixture(page, 10, false, true);
  const r = await new DemandReader(page, 120).collect();
  expect(r.complete).toBe(true);
  expect(r.aircraft).toHaveLength(69);
  expect(new Set(r.aircraft.map(a => a.routeId)).size).toBe(69);
  expect(new Set(r.aircraft.map(a => a.aircraftId)).size).toBe(69);
  expect(await page.evaluate(() => (window as any).mutations)).toBe(0);
});

test('interior repeat cannot hide conflicting aircraft identity', async ({page}) => {
  await nativeFullBoundaryFixture(page, 10, true, true);
  const r = await new DemandReader(page, 120).collect();
  expect(r.complete).toBe(false);
  expect(r.aircraft.length).toBeLessThan(69);
  expect(await page.evaluate(() => (window as any).mutations)).toBe(0);
});
