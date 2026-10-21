import {test,expect} from '@playwright/test';
import {reuseCurrentFleetPageForTarget} from '../../demand/navigation';
import type {AircraftSnapshot} from '../../demand/types';

const target:AircraftSnapshot={
  aircraftId:'2',registration:'N-002',routeId:'11',routeLabel:'BBB - GRU',
  from:'BBB',to:'GRU',state:'ready',
  capacity:{Y:100,J:0,F:0},remaining:{Y:100,J:0,F:0},
  dailyTotal:{Y:1000,J:0,F:0},observedAt:new Date().toISOString()
};

test('reuses already visited verified Fleet page without re-opening Fleet',async({page})=>{
 await page.setContent(`<div id="routeAction" style="display:none"><div id="routesContainer">
 <button>Routes (2)</button>
 <div id="routeMainList10"><a onclick="playSound('neutral_click');Ajax('fleet_details.php?id=1','detailsAction');">OTHER</a></div>
 <div id="routeMainList11"><a onclick="playSound('neutral_click');Ajax('fleet_details.php?id=2','detailsAction');">N-002</a></div>
 </div></div>
 <div id="route-name"><span class="glyphicons-chevron-left" onclick="document.getElementById('routeAction').style.display='block'">Back</span></div>`);
 expect(await reuseCurrentFleetPageForTarget(page,target,2,1500)).toBe(true);
 expect(await page.locator('#routeAction').isVisible()).toBe(true);
 expect(await reuseCurrentFleetPageForTarget(page,{...target,routeId:'12'},2,1500)).toBe(false);
 expect(await reuseCurrentFleetPageForTarget(page,{...target,aircraftId:'3'},2,1500)).toBe(false);
 await page.locator('#routesContainer button').evaluate(e=>e.textContent='Routes (3)');
 await expect(reuseCurrentFleetPageForTarget(page,target,2,1500)).rejects.toThrow('DEPARTURE_FLEET_COUNT_CHANGED');
});

test('an absent or unverified current Fleet page never authorizes shortcut',async({page})=>{
 await page.setContent('<div id="routeAction" style="display:none"><div id="routesContainer"></div></div>');
 expect(await reuseCurrentFleetPageForTarget(page,target,2,1000)).toBe(false);
 expect(await reuseCurrentFleetPageForTarget(page,{...target,aircraftId:'invalid'},2,1000)).toBe(false);
 expect(await reuseCurrentFleetPageForTarget(page,target,0,1000)).toBe(false);
});
