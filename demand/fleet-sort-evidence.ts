import type { Page } from '@playwright/test';

/**
 * Inspect the CURRENT native Fleet screen without opening another page or
 * interacting with sort/search controls. Never keep raw callbacks, HTML,
 * route IDs, registrations, input text, or URLs in telemetry.
 */
export interface FleetSortEvidence {
  schemaVersion: 1;
  status: 'OBSERVED'|'NO_NATIVE_SORT_CONTROL'|'UNAVAILABLE';
  observedControls: number;
  nativeNextSort: 'EMPTY'|'NONEMPTY'|'UNVERIFIED'|'ABSENT';
  candidates: Array<{
    kind: 'select'|'button'|'link'|'input';
    hint: 'sort'|'order'|'filter'|'search'|'route';
    callback: 'native-routes'|'function'|'none'|'other';
    optionValues?: string[];
  }>;
  mutationAuthorized: false;
}

export async function inspectFleetSortEvidence(page: Page): Promise<FleetSortEvidence> {
  const empty: FleetSortEvidence = {
    schemaVersion:1,status:'UNAVAILABLE',observedControls:0,
    nativeNextSort:'UNVERIFIED',candidates:[],mutationAuthorized:false
  };
  try {
    // One passive DOM read. No click, no JavaScript injection, no fetch,
    // no session credentials, no user text, no raw route/aircraft identity.
    const observed = await page.locator('#routeAction').evaluate(root=>{
      const container=root.querySelector('#routesContainer');
      if(!container)return null;
      const pagination=container.querySelector('.pagination');
      const next=Array.from(pagination?.querySelectorAll('a')||[])
        .find(a=>(a.textContent||'').trim().toLowerCase()==='next');
      const nextRaw=next?.getAttribute('onclick')||'';
      const nextMatch=/^Ajax\('routes\.php\?start=\d+&sort=([^']*)','routeAction',this\);$/.exec(nextRaw.replace(/\s/g,''));
      const nextSort: 'EMPTY'|'NONEMPTY'|'UNVERIFIED'|'ABSENT'=next
        ? nextMatch ? (nextMatch[1]?'NONEMPTY':'EMPTY') : 'UNVERIFIED'
        : 'ABSENT';
      const supportedOption=(value:string)=>/^[A-Za-z0-9_-]{1,32}$/.test(value)?value:'REDACTED';
      const controls=Array.from(root.querySelectorAll<HTMLElement>(
        'select,button,a,input[type="search"],input[type="text"]'
      )).filter(el=>!el.closest('[id^="routeMainList"]') && !el.closest('.pagination'));
      const candidates=controls.flatMap(el=>{
        const raw=el.getAttribute('onclick')||el.getAttribute('onchange')||'';
        const hintText=[el.id,el.getAttribute('name'),el.getAttribute('aria-label'),
          el.getAttribute('title'),el.getAttribute('placeholder'),el.getAttribute('class'),
          el.tagName==='SELECT'?'sort':'',el.tagName==='INPUT'?'search':'',
          el.tagName==='A'?(el.textContent||'').trim().slice(0,40):''].join(' ').toLowerCase();
        const hint: 'sort'|'order'|'filter'|'search'|'route'|null =
          /sort/.test(hintText)?'sort':
          /order/.test(hintText)?'order':
          /filter/.test(hintText)?'filter':
          /search/.test(hintText)?'search':
          /routes\.php/.test(raw)?'route':null;
        if(!hint)return [];
        const callback:'native-routes'|'function'|'none'|'other' =
          /^Ajax\('routes\.php(?:\?[^']*)?','routeAction',this(?:,false,false)?\);$/.test(raw.replace(/\s/g,''))
            ? 'native-routes' : /^[A-Za-z_$][\w$]*\(/.test(raw) ? 'function' :
            raw ? 'other':'none';
        const kind: 'select'|'button'|'link'|'input' =
          el.tagName==='SELECT'?'select':el.tagName==='A'?'link':
          el.tagName==='BUTTON'?'button':'input';
        const optionValues=kind==='select'?Array.from((el as HTMLSelectElement).options)
          .slice(0,20).map(x=>supportedOption(x.value)):undefined;
        return [{kind,hint,callback,...(optionValues?{optionValues}: {})}];
      });
      return {nativeNextSort:nextSort,candidates:candidates.slice(0,20)};
    });
    if(!observed)return empty;
    return {
      schemaVersion:1,status:observed.candidates.length?'OBSERVED':'NO_NATIVE_SORT_CONTROL',
      observedControls:observed.candidates.length,nativeNextSort:observed.nativeNextSort,
      candidates:observed.candidates,mutationAuthorized:false
    };
  } catch {
    return empty;
  }
}
