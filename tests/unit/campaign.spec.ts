import { test, expect } from '@playwright/test';
import { CampaignUtils } from '../../utils/campaign.utils';

const withReputation = async (value:string|undefined,fn:()=>Promise<void>)=>{
  const previous=process.env.INCREASE_AIRLINE_REPUTATION;
  try{
    if(value===undefined)delete process.env.INCREASE_AIRLINE_REPUTATION;
    else process.env.INCREASE_AIRLINE_REPUTATION=value;
    await fn();
  }finally{
    if(previous===undefined)delete process.env.INCREASE_AIRLINE_REPUTATION;
    else process.env.INCREASE_AIRLINE_REPUTATION=previous;
  }
};

test('campaign verification accepts campaigns already active before departure',async({page})=>{
 await withReputation('true',async()=>{
  await page.setContent(`
   <button>Marketing</button>
   <table>
    <tr><td> Eco friendly</td></tr>
    <tr><td> Airline reputation</td></tr>
   </table>
  `);
  const evidence=await new CampaignUtils(page).createCampaign();
  expect(evidence).toMatchObject({
   allRequiredVerified:true,
   departureAuthorized:true,
   ecoFriendly:{status:'already_active',verifiedActive:true,purchaseAttempted:false},
   airlineReputation:{status:'already_active',verifiedActive:true,purchaseAttempted:false}
  });
 });
});

test('campaign verification accepts active labels without glyphs and with hyphen variant',async({page})=>{
 await withReputation('true',async()=>{
  await page.setContent(`
   <button>Marketing</button>
   <table>
    <tr><td>Eco-friendly</td></tr>
    <tr><td>Airline reputation</td></tr>
   </table>
  `);
  const evidence=await new CampaignUtils(page).createCampaign();
  expect(evidence).toMatchObject({
   allRequiredVerified:true,departureAuthorized:true,
   ecoFriendly:{status:'already_active',verifiedActive:true},
   airlineReputation:{status:'already_active',verifiedActive:true}
  });
 });
});

test('eco purchase accepts space-separated current AM4 option label',async({page})=>{
 await withReputation('false',async()=>{
  await page.setContent(`
   <button>Marketing</button>
   <button>New campaign</button>
   <table id="campaigns"><tr><td>Eco friendly Increases</td></tr></table>
   <button id="buyEco">$</button>
   <script>
    document.querySelector('#buyEco').onclick=()=>{
      const row=document.createElement('tr');
      row.innerHTML='<td>Eco friendly</td>';
      document.querySelector('#campaigns').appendChild(row);
    };
   </script>
  `);
  const evidence=await new CampaignUtils(page).createCampaign();
  expect(evidence.ecoFriendly).toMatchObject({
   purchaseAttempted:true,verifiedActive:true,status:'purchased_verified'
  });
  expect(evidence.departureAuthorized).toBe(true);
 });
});

test('eco purchase accepts a shortened unique current label after New campaign',async({page})=>{
 await withReputation('false',async()=>{
  await page.setContent(`
   <button>Marketing</button>
   <button>New campaign</button>
   <table id="campaigns"><tr><td>Eco-friendly boost</td></tr></table>
   <button id="buyEco">$</button>
   <script>
    document.querySelector('#buyEco').onclick=()=>{
      const row=document.createElement('tr');
      row.innerHTML='<td>Eco friendly</td>';
      document.querySelector('#campaigns').appendChild(row);
    };
   </script>
  `);
  const evidence=await new CampaignUtils(page).createCampaign();
  expect(evidence.ecoFriendly).toMatchObject({
    status:'purchased_verified',verifiedActive:true,purchaseAttempted:true
  });
  expect(evidence.departureAuthorized).toBe(true);
 });
});

test('ambiguous visible Eco options fail closed before any option click',async({page})=>{
 await withReputation('false',async()=>{
  await page.setContent(`
   <button>Marketing</button>
   <button id="newCampaign">New campaign</button>
   <table>
    <tr><td id="eco1">Eco-friendly boost</td></tr>
    <tr><td id="eco2">Eco friendly special</td></tr>
   </table>
   <script>
    window.optionClicks=0;
    document.querySelector('#eco1').onclick=()=>window.optionClicks++;
    document.querySelector('#eco2').onclick=()=>window.optionClicks++;
   </script>
  `);
  const evidence=await new CampaignUtils(page).createCampaign();
  expect(evidence.ecoFriendly).toMatchObject({
    status:'unverified',verifiedActive:false,purchaseAttempted:false,
    reason:'ECO_OPTION_NOT_UNIQUE_VISIBLE'
  });
  expect(evidence.departureAuthorized).toBe(false);
  expect(await page.evaluate(()=>(window as any).optionClicks)).toBe(0);
 });
});

test('eco campaign is re-read and confirmed after purchase',async({page})=>{
 await withReputation('false',async()=>{
  await page.setContent(`
   <button>Marketing</button>
   <button>New campaign</button>
   <button style="display:none">$</button>
   <table id="campaigns"><tr><td>Eco-friendly Increases</td></tr></table>
   <button id="buyEco">$</button>
   <script>
    document.querySelector('#buyEco').onclick=()=>{
      const row=document.createElement('tr');
      row.innerHTML='<td> Eco friendly</td>';
      document.querySelector('#campaigns').appendChild(row);
    };
   </script>
  `);
  const evidence=await new CampaignUtils(page).createCampaign();
  expect(evidence.ecoFriendly).toMatchObject({
   activeBefore:false,purchaseAttempted:true,verifiedActive:true,status:'purchased_verified',
   reason:'POST_PURCHASE_ACTIVE_CONFIRMED'
  });
  expect(evidence.airlineReputation.status).toBe('not_required');
  expect(evidence.allRequiredVerified).toBe(true);
 });
});

test('hidden stale active-campaign rows do not mask the visible current campaign state',async({page})=>{
 await withReputation('true',async()=>{
  await page.setContent(`
   <button>Marketing</button>
   <table style="display:none">
    <tr><td> Eco friendly</td></tr>
    <tr><td> Airline reputation</td></tr>
   </table>
   <table>
    <tr><td> Eco friendly</td></tr>
    <tr><td> Airline reputation</td></tr>
   </table>
  `);
  const evidence=await new CampaignUtils(page).createCampaign();
  expect(evidence).toMatchObject({
   allRequiredVerified:true,departureAuthorized:true,
   ecoFriendly:{status:'already_active',verifiedActive:true},
   airlineReputation:{status:'already_active',verifiedActive:true}
  });
 });
});

test('open campaign panel never re-clicks an obscured Marketing menu',async({page})=>{
 await withReputation('false',async()=>{
  await page.setContent(`
   <button id="marketing" style="position:absolute;left:0;top:0;width:120px;height:36px">Marketing</button>
   <div id="cover" style="position:absolute;left:0;top:0;width:120px;height:36px;z-index:10"></div>
   <div style="margin-top:60px">
    <button>New campaign</button>
    <table id="campaigns"><tr><td>Eco-friendly Increases</td></tr></table>
    <button id="buyEco">$</button>
   </div>
   <script>
    document.querySelector('#buyEco').onclick=()=>{
      const row=document.createElement('tr');row.innerHTML='<td> Eco friendly</td>';
      document.querySelector('#campaigns').appendChild(row);
    };
   </script>
  `);
  const evidence=await new CampaignUtils(page).createCampaign();
  expect(evidence.ecoFriendly).toMatchObject({status:'purchased_verified',verifiedActive:true});
  expect(evidence.departureAuthorized).toBe(true);
 });
});

test('reputation campaign is re-read and confirmed after purchase',async({page})=>{
 await withReputation('true',async()=>{
  process.env.CAMPAIGN_TYPE='1';process.env.CAMPAIGN_DURATION='4';
  try{
   await page.setContent(`
    <button>Marketing</button>
    <button>New campaign</button>
    <table id="campaigns">
      <tr><td> Eco friendly</td></tr>
      <tr><td>Increase airline reputation</td></tr>
      <tr><td>Campaign 1</td><td><button class="btn-danger">Buy</button></td></tr>
    </table>
    <select id="dSelector"><option value="1">4h</option></select>
    <script>
      document.querySelector('.btn-danger').onclick=()=>{
        const row=document.createElement('tr');
        row.innerHTML='<td> Airline reputation</td>';
        document.querySelector('#campaigns').appendChild(row);
      };
    </script>
   `);
   const evidence=await new CampaignUtils(page).createCampaign();
   expect(evidence.airlineReputation).toMatchObject({
    activeBefore:false,purchaseAttempted:true,verifiedActive:true,status:'purchased_verified'
   });
   expect(evidence.allRequiredVerified).toBe(true);
  }finally{
   delete process.env.CAMPAIGN_TYPE;delete process.env.CAMPAIGN_DURATION;
  }
 });
});

test('unconfirmed campaign never authorizes departure',async({page})=>{
 await withReputation('false',async()=>{
  await page.setContent(`
   <button>Marketing</button>
   <button>New campaign</button>
   <table><tr><td>Eco-friendly Increases</td></tr></table>
   <button>$</button>
  `);
  const evidence=await new CampaignUtils(page).createCampaign();
  expect(evidence.ecoFriendly).toMatchObject({
   purchaseAttempted:true,verifiedActive:false,status:'unverified',
   reason:'POST_PURCHASE_ACTIVE_NOT_CONFIRMED'
  });
  expect(evidence.allRequiredVerified).toBe(false);
  expect(evidence.departureAuthorized).toBe(false);
 });
});

test('read-only recovery verifies unique active campaigns without purchases or menu clicks',async({page})=>{
 await withReputation('true',async()=>{
  await page.setContent(`
   <button id="marketing">Marketing</button>
   <button id="buy">$ 1000</button>
   <table><tr><td>Eco-friendly</td></tr><tr><td>Airline reputation</td></tr></table>
   <script>
    window.clicks=0;
    document.querySelector('#buy').onclick=()=>window.clicks++;
    document.querySelector('#marketing').onclick=()=>window.clicks++;
   </script>
  `);
  const evidence=await new CampaignUtils(page).verifyRequiredCampaignsReadOnly();
  expect(evidence).toMatchObject({
   allRequiredVerified:true,departureAuthorized:true,
   ecoFriendly:{status:'already_active',purchaseAttempted:false,verifiedActive:true},
   airlineReputation:{status:'already_active',purchaseAttempted:false,verifiedActive:true}
  });
  expect(await page.evaluate(()=>(window as any).clicks)).toBe(0);
 });
});

test('read-only recovery fails closed if required reputation is missing',async({page})=>{
 await withReputation('true',async()=>{
  await page.setContent('<table><tr><td>Eco-friendly</td></tr></table><button>$ 1000</button>');
  const evidence=await new CampaignUtils(page).verifyRequiredCampaignsReadOnly();
  expect(evidence.departureAuthorized).toBe(false);
  expect(evidence.airlineReputation).toMatchObject({
   status:'unverified',purchaseAttempted:false,verifiedActive:false
  });
 });
});

test('read-only recovery rejects duplicate or hidden stale active labels',async({page})=>{
 await withReputation('false',async()=>{
  await page.setContent(`
   <table style="display:none"><tr><td>Eco-friendly</td></tr></table>
   <table><tr><td>Eco-friendly</td></tr><tr><td>Eco-friendly</td></tr></table>
  `);
  const evidence=await new CampaignUtils(page).verifyRequiredCampaignsReadOnly();
  expect(evidence.departureAuthorized).toBe(false);
  expect(evidence.ecoFriendly).toMatchObject({
   status:'unverified',purchaseAttempted:false,verifiedActive:false,
   reason:'READONLY_ACTIVE_NOT_UNIQUE_OR_MISSING'
  });
 });
});
