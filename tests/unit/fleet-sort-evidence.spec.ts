import { test, expect } from '@playwright/test';
import { inspectFleetSortEvidence } from '../../demand/fleet-sort-evidence';

test('reads verified native cursor and sort selection without clicks, network or private values',async({page})=>{
  await page.route('**/*', route=>route.abort());
  await page.setContent(`<div id="routeAction">
    <select id="fleet-sort"><option value="reg">Registration</option>
    <option value="aircraft_id">Aircraft ID</option>
    <option value="private:customer@example.com">Unsafe value</option></select>
    <input type="search" id="aircraft-search" value="SECRET ACCOUNT TEXT"/>
    <div id="routesContainer"><div id="routeMainList123456">
      <a onclick="Ajax('fleet_details.php?id=99999','detailsAction');">SECRET REGISTRATION</a>
    </div><div class="pagination"><a onclick="Ajax('routes.php?start=20&sort=','routeAction',this);">Next</a></div></div>
  </div>`);
  const evidence=await inspectFleetSortEvidence(page);
  expect(evidence).toMatchObject({
    status:'OBSERVED',nativeNextSort:'EMPTY',mutationAuthorized:false,
    observedControls:2
  });
  expect(evidence.candidates.some(c=>c.kind==='select' && c.optionValues?.includes('aircraft_id'))).toBe(true);
  const serialized=JSON.stringify(evidence);
  for(const forbidden of ['SECRET','ACCOUNT','customer@example.com','123456','99999','REGISTRATION'])
    expect(serialized).not.toContain(forbidden);
});

test('missing sort controls still return safe pagination evidence',async({page})=>{
  await page.setContent(`<div id="routeAction"><div id="routesContainer">
    <div id="routeMainList1"></div><div class="pagination">
    <a onclick="Ajax('routes.php?start=20&sort=','routeAction',this);">Next</a></div>
  </div></div>`);
  const evidence=await inspectFleetSortEvidence(page);
  expect(evidence.status).toBe('NO_NATIVE_SORT_CONTROL');
  expect(evidence.nativeNextSort).toBe('EMPTY');
  expect(evidence.candidates).toHaveLength(0);
  expect(evidence.mutationAuthorized).toBe(false);
});

test('unverified pagination shape is never promoted into a sorting action',async({page})=>{
  await page.setContent(`<div id="routeAction"><select id="sort-select">
    <option value="name">Name</option></select>
    <div id="routesContainer"><div class="pagination">
    <a onclick="unknownFunction('private-data')">Next</a></div></div></div>`);
  const evidence=await inspectFleetSortEvidence(page);
  expect(evidence.nativeNextSort).toBe('UNVERIFIED');
  expect(evidence.mutationAuthorized).toBe(false);
  expect(JSON.stringify(evidence)).not.toContain('private-data');
});

test('absent Fleet root returns unavailable without throwing or interacting',async({page})=>{
  await page.setContent('<div>unrelated application</div>');
  const result=await inspectFleetSortEvidence(page);
  expect(result).toMatchObject({status:'UNAVAILABLE',mutationAuthorized:false,candidates:[]});
});
