import { test, expect } from '@playwright/test';
import { PlaywrightDeparturePort, validatedDispatchSnapshot } from '../../demand/departure-port';
import type { AircraftSnapshot, CollectionResult } from '../../demand/types';

const seed=():AircraftSnapshot=>({
  aircraftId:'1',registration:'TEST',routeId:'10',routeLabel:'AAA - GRU',from:'AAA',to:'GRU',
  state:'ready',capacity:{Y:100,J:0,F:0},remaining:{Y:100,J:0,F:0},
  dailyTotal:{Y:500,J:0,F:0},observedAt:new Date().toISOString()
});
const full=():CollectionResult=>({aircraft:[seed()],complete:true,expectedRoutes:1,warnings:[]});

test('same-run snapshot only reuses complete, unique identities with unchanged live route count',()=>{
 expect(validatedDispatchSnapshot(full(),1)?.aircraft).toHaveLength(1);
 expect(validatedDispatchSnapshot(full(),2)).toBeNull();
 expect(validatedDispatchSnapshot({...full(),complete:false},1)).toBeNull();
 expect(validatedDispatchSnapshot({...full(),expectedRoutes:2},1)).toBeNull();
 const dup={...full(),expectedRoutes:2,aircraft:[seed(),{...seed(),aircraftId:'2'}]};
 expect(validatedDispatchSnapshot(dup,2)).toBeNull(); // duplicate route id
 const twin={...full(),expectedRoutes:2,aircraft:[seed(),{...seed(),routeId:'11'}]};
 expect(validatedDispatchSnapshot(twin,2)).toBeNull(); // duplicate aircraft id
 expect(validatedDispatchSnapshot({...full(),aircraft:[{...seed(),routeId:'invalid'}]},1)).toBeNull();
 expect(validatedDispatchSnapshot({...full(),aircraft:[{...seed(),aircraftId:'invalid'}]},1)).toBeNull();
 expect(validatedDispatchSnapshot({...full(),aircraft:[{...seed(),capacity:null}]},1)).toBeNull();
 expect(validatedDispatchSnapshot({...full(),aircraft:[{...seed(),issue:'invalid state'}]},1)).toBeNull();
});

test('departure seeds global fleet once without opening every aircraft detail again',async({page})=>{
 // Native-looking local fixture; all network/game access is absent.
 await page.setContent(`<button id="popBtn1" onclick="$('.popMenuBtn').removeClass('active');$(this).addClass('active');$('#detailsAction').hide();Ajax('routes.php','routeAction',this,false,false);">Fleet</button>
 <div id="routeAction"><div id="routesContainer"><button>Routes (1)</button><div class="row classPAX listDepartable" id="routeMainList10"><button id="listDepart10">Depart</button></div></div></div>
 <div id="detailsAction" style="display:none"></div>
 <script>function $(s){return {removeClass(){return this},addClass(){return this},hide(){return this}}}
 function Ajax(){const old=document.getElementById('routesContainer');old.replaceWith(old.cloneNode(true));}</script>`);
 const snapshot=full();
 const result=await new PlaywrightDeparturePort(page,1500,undefined,snapshot).collect();
 expect(result.complete).toBe(true);
 expect(result.expectedRoutes).toBe(1);
 expect(result.aircraft[0].aircraftId).toBe('1');
 expect(result.aircraft[0].routeId).toBe('10');
});
