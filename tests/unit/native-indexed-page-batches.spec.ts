import { test,expect,type Page } from '@playwright/test';
import { inspectNativeIndexedPageReadOnly } from '../../demand/rolling-first-page';
import { PlaywrightDeparturePort } from '../../demand/departure-port';

async function pages(page:Page,opts:{total?:number;readyPage?:number;badNext?:boolean;reordered?:boolean;churnMode?:'once'|'continuous'|'overlap'}={}){
 const total=opts.total??47;
 await page.route('**/*',route=>route.abort());
 await page.setContent('<button id="mapRoutes" onclick="hideAllWhenClick();menuFleet(\'Routes\');">Fleet</button><div id="routeAction"></div>');
 await page.evaluate(({total,readyPage,badNext,reordered,churnMode})=>{
  const w=window as any;w.pageReads=[];w.departCalls=0;w.churn=0;
  w.hideAllWhenClick=()=>{};
  const show=(offset:number)=>{
    if(offset===20)w.churn++;
    w.pageReads.push(offset);let index=offset/20;
    const prior=document.getElementById('routesContainer');
    prior?.remove();
    const div=document.createElement('div');div.id='routesContainer';
    const heading=document.createElement('button');
    heading.textContent='Routes ('+total+')';div.append(heading);
    const count=Math.min(20,total-offset);
    const sequence=Array.from({length:count},(_,i)=>offset+i+1);
    if(churnMode&&churnMode!=='overlap'&&index===0&&w.churn>0){
      const rotation=churnMode==='continuous'?w.churn%20:1;
      sequence.push(...sequence.splice(0,rotation));
    }
    if(churnMode==='overlap'&&index===1)sequence[0]=20;
    if(reordered&&index===1&&w.pageReads.filter((x:number)=>x===20).length>1)sequence.reverse();
    for(const id of sequence){
      const route=1000+id,aircraft=2000+id;
      const row=document.createElement('div');
      row.id='routeMainList'+route;
      row.className='row classPAX'+(index===readyPage&&id===offset+1?' listDepartable':'');
      const link=document.createElement('a');
      link.setAttribute('onclick',"playSound('neutral_click');Ajax('fleet_details.php?id="+aircraft+"','detailsAction');if(intro==0){$('#routeAction').hide();}");
      const reg=document.createElement('span');reg.id='acRegList'+aircraft;reg.textContent='TEST-'+id;link.append(reg,' - aircraft');row.append(link);
      if(index===readyPage&&id===offset+1){
        const button=document.createElement('button');button.id='listDepart'+route;button.textContent='Depart';button.onclick=()=>{w.departCalls++;};
        row.append(button);
      }else row.append('Onboard: 40 / 0 / 0');
      div.append(row);
    }
    const nav=document.createElement('ul');nav.className='pagination';
    if(offset>0){const prev=document.createElement('a');prev.href='#';prev.textContent='Previous';prev.setAttribute('onclick',
      "Ajax('routes.php?start="+(offset-20)+"&sort=','routeAction',this);");nav.append(prev);}
    if(offset+20<total){const next=document.createElement('a');next.href='#';next.textContent='Next';next.setAttribute('onclick',
      "Ajax('routes.php?start="+(badNext?999:offset+20)+"&sort=','routeAction',this);");nav.append(next);}
    div.append(nav);document.getElementById('routeAction')!.append(div);
  };
  w.menuFleet=()=>show(0);
  w.Ajax=(url:string)=>{const m=url.match(/start=(\d+)/);if(m)show(Number(m[1]));};
 },{total,readyPage:opts.readyPage??-1,badNext:!!opts.badNext,reordered:!!opts.reordered,churnMode:opts.churnMode??null});
}

test('native pagination discovers page two of a 47-aircraft roster without any Depart click',async({page})=>{
 await pages(page,{readyPage:1});
 const second=await inspectNativeIndexedPageReadOnly(page,1,1200);
 expect(second).toMatchObject({status:'STABLE',routeTotal:47,visible:20,ready:1,mutationAuthorized:false});
 expect(second.aircraft[0]).toMatchObject({state:'ready',aircraftId:'2021',routeId:'1021'});
 expect(await page.evaluate(()=>(window as any).pageReads)).toEqual([0,20]);
 expect(await page.evaluate(()=>(window as any).departCalls)).toBe(0);
});

test('native page three has seven aircraft and is never mistaken for a missing fleet',async({page})=>{
 await pages(page);
 const third=await inspectNativeIndexedPageReadOnly(page,2,1200);
 expect(third).toMatchObject({status:'STABLE',routeTotal:47,visible:7,ready:0});
 expect(await page.evaluate(()=>(window as any).pageReads)).toEqual([0,20,40]);
 expect(await page.evaluate(()=>(window as any).departCalls)).toBe(0);
});

test('native pagination rejects a wrong Next callback before clicking it',async({page})=>{
 await pages(page,{badNext:true});
 const second=await inspectNativeIndexedPageReadOnly(page,1,1200);
 expect(second.status).toBe('UI_UNVERIFIED');
 expect(await page.evaluate(()=>(window as any).pageReads)).toEqual([0]);
 expect(await page.evaluate(()=>(window as any).departCalls)).toBe(0);
});

test('collector skips twenty verified inflight aircraft and scans all pages without claiming full fleet',async({page})=>{
 await pages(page);
 const port=new PlaywrightDeparturePort(page,1400,undefined,undefined,true);
 const outcome=await port.collect();
 expect(outcome).toMatchObject({complete:false,expectedRoutes:47,
   observationScope:'native-individual-page',windowPageIndex:2,
   windowScanExhaustedVerified:true,aircraft:[],warnings:[]});
 expect(port.navigationMetrics().fullFleetScans).toBe(0);
 expect(await page.evaluate(()=>(window as any).departCalls)).toBe(0);
});

test('landing changes first page order: bounded rebase and no mutation',async({page})=>{
 await pages(page,{churnMode:'once'});
 const port=new PlaywrightDeparturePort(page,1400,undefined,undefined,true);
 const result=await port.collect();
 expect(result).toMatchObject({complete:false,expectedRoutes:47,
   windowPageIndex:2,observationScope:'native-individual-page',
   windowScanExhaustedVerified:true,aircraft:[],warnings:[]});
 expect(port.navigationMetrics().nativePageRebases).toBe(1);
 expect(await page.evaluate(()=>(window as any).departCalls)).toBe(0);
});

test('continuous arrivals stop after two safe rebases without click',async({page})=>{
 await pages(page,{churnMode:'continuous'});
 const port=new PlaywrightDeparturePort(page,1400,undefined,undefined,true);
 const result=await port.collect();
 expect(result).toMatchObject({complete:false,aircraft:[],
   windowScanExhaustedVerified:false,observationScope:undefined,
   warnings:['ROLLING_WINDOW_UNVERIFIED']});
 expect(port.navigationMetrics().nativePageRebases).toBe(2);
 expect(await page.evaluate(()=>(window as any).departCalls)).toBe(0);
});

test('cross-page duplicate aircraft is a detected pagination drift',async({page})=>{
 await pages(page,{churnMode:'overlap'});
 const port=new PlaywrightDeparturePort(page,1400,undefined,undefined,true);
 const result=await port.collect();
 expect(result).toMatchObject({complete:false,aircraft:[],
   windowScanExhaustedVerified:false,warnings:['ROLLING_WINDOW_UNVERIFIED']});
 expect(port.navigationMetrics().nativePageRebases).toBe(2);
 expect(await page.evaluate(()=>(window as any).departCalls)).toBe(0);
});
