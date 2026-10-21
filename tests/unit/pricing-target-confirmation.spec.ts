import { test, expect } from '@playwright/test';
import { PlaywrightPricingPort, verifiedTargetPricingConfirmation } from '../../pricing/playwright-port';
import { DemandReader } from '../../demand/reader';
import type { AircraftSnapshot } from '../../demand/types';

const now=()=>new Date().toISOString();
const desired={Y:1100,J:2160,F:3180};
const aircraft=():AircraftSnapshot=>({
  aircraftId:'101',routeId:'9001',registration:'TEST-101',
  routeLabel:'GRU - AAA',from:'GRU',to:'AAA',state:'ready',
  capacity:{Y:100,J:10,F:5},remaining:{Y:100,J:10,F:5},dailyTotal:{Y:100,J:10,F:5},
  observedAt:now(),
  fares:{source:'inspected-auto-control',automatic:{Y:1000,J:2000,F:3000},
    current:{...desired},
    saveControl:{endpointVerified:true,target:'route',targetMatchesContext:true,shape:'native'}}
});

test('native price confirmation requires fresh per-aircraft identity, exact saved fares, and the route Save target',()=>{
 const expected=aircraft(),fresh=aircraft();
 expect(verifiedTargetPricingConfirmation(expected,fresh,desired)).toBe(true);
 expect(verifiedTargetPricingConfirmation(expected,{...fresh,aircraftId:'102'},desired)).toBe(false);
 expect(verifiedTargetPricingConfirmation(expected,{...fresh,routeId:'9002'},desired)).toBe(false);
 expect(verifiedTargetPricingConfirmation(expected,{...fresh,registration:'OTHER'},desired)).toBe(false);
 expect(verifiedTargetPricingConfirmation(expected,{...fresh,to:'BBB'},desired)).toBe(false);
 expect(verifiedTargetPricingConfirmation(expected,{...fresh,state:'inflight'},desired)).toBe(false);
 expect(verifiedTargetPricingConfirmation(expected,{...fresh,capacity:{Y:101,J:10,F:5}},desired)).toBe(false);
 expect(verifiedTargetPricingConfirmation(expected,{...fresh,observedAt:new Date(Date.now()-301000).toISOString()},desired)).toBe(false);
 expect(verifiedTargetPricingConfirmation(expected,{...fresh,fares:{...fresh.fares!,current:{...desired,Y:1101}}},desired)).toBe(false);
 expect(verifiedTargetPricingConfirmation(expected,{...fresh,fares:{...fresh.fares!,saveControl:{...fresh.fares!.saveControl!,targetMatchesContext:false}}},desired)).toBe(false);
 expect(verifiedTargetPricingConfirmation(expected,{...fresh,issue:'unverified'},desired)).toBe(false);
});

test('pricing confirmation does not rescan entire fleet; it fresh-reads only the native target',async({page})=>{
 // Navigation is a local synthetic fixture. It does not contact or mutate the game.
 await page.setContent(`<button id="popBtn1" onclick="$('.popMenuBtn').removeClass('active');$(this).addClass('active');$('#detailsAction').hide();Ajax('routes.php','routeAction',this,false,false);">Fleet</button>
 <div id="routeAction"><div id="routesContainer"><button>Routes (1)</button><div class="row classPAX" id="routeMainList9001">Target</div></div></div>
 <div id="detailsAction" style="display:none"></div>
 <script>function $(s){return {removeClass(){return this},addClass(){return this},hide(){return this}}}
 function Ajax(){const old=document.getElementById('routesContainer');old.replaceWith(old.cloneNode(true));}</script>`);
 const expected=aircraft();
 const originalCollect=DemandReader.prototype.collect;
 const originalRead=DemandReader.prototype.readReadyAircraftDetails;
 let collectCalls=0,targetCalls=0;
 try {
   DemandReader.prototype.collect=async function(){collectCalls++;throw new Error('FULL_FLEET_RESCAN_NOT_ALLOWED_AFTER_SAVE');};
   DemandReader.prototype.readReadyAircraftDetails=async function(a){
     targetCalls++;
     expect(a.aircraftId).toBe(expected.aircraftId);
     expect(a.routeId).toBe(expected.routeId);
     return aircraft();
   };
   const observed=await new PlaywrightPricingPort(page,2000).confirm(expected,desired);
   expect(observed?.aircraftId).toBe(expected.aircraftId);
   expect(collectCalls).toBe(0);
   expect(targetCalls).toBe(1);
 } finally {
   DemandReader.prototype.collect=originalCollect;
   DemandReader.prototype.readReadyAircraftDetails=originalRead;
 }
});
