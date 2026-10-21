import { runSupplies } from '../supplies/run';
import {postDispatchSupplyDecision} from '../supplies/post-dispatch';
import { supplyConfig } from '../supplies/policy';
import { researchConfig } from '../optimization/research-reader';
import { optimizationConfig } from '../optimization/report';
import { readDemandConfig } from '../demand/config';
import { runDemandSimulationDetailed } from '../demand/run';
import { executionEnvironment, runDemandExecution } from '../demand/execute-run';
import { pricingExecutionSettings, runTicketPricingExecution } from '../pricing/run';
import { routeExecutionSettings, runRouteExecution } from '../optimization/route-execution-run';
import { withRunLock } from '../utils/run-lock';
import { loginForReadOnlyCollection } from '../utils/read-only-login';
import { runInitialUiHealthCheck } from '../utils/ui-health';
import { assertNoInteractiveChallenge } from '../utils/challenge-guard';
import { evaluateRunPhaseBudget, isSkippedDeparturePhaseFailure, MUTATION_PHASE_START_MINIMUM_MS, LIVE_RUN_TIMEOUT_MS, LIVE_RUN_FINALIZATION_RESERVE_MS } from '../utils/run-time-budget';
import { writeSemiAutomaticSummary } from '../utils/semi-automatic';
import { test } from '@playwright/test';
import { GeneralUtils } from '../utils/general.utils';
import { FuelUtils } from '../utils/fuel.utils';
import { CampaignUtils } from '../utils/campaign.utils';
import { FleetUtils } from '../utils/fleet.utils';
import { MaintenanceUtils } from '../utils/maintenance.utils';
import * as fs from 'fs';
import * as path from 'path';

require('dotenv').config();

test('All Operations', async ({ page }) => {
  await withRunLock(async () => {
  const demandConfig = readDemandConfig();
  if (demandConfig.enabled) {
    executionEnvironment(demandConfig);
    supplyConfig(); // Valida a politica de compras antes do login.
    optimizationConfig(); // Rejeita configuracoes invalidas antes do login.
    researchConfig();
    pricingExecutionSettings(); // Valida o contexto do ajuste real de tarifas antes do login.
    routeExecutionSettings(); // Valida o contexto de reroute real antes do login.
    const runTimeoutMs=demandConfig.dryRun ? 600000 : LIVE_RUN_TIMEOUT_MS;
    const runStartedEpochMs=Date.now();
    test.setTimeout(runTimeoutMs);
    // Keep a hard finalization reserve for fresh confirmations, state save and artifacts.
    const finalizationReserveMs=LIVE_RUN_FINALIZATION_RESERVE_MS;
    const phaseDeadlineEpochMs=runStartedEpochMs+runTimeoutMs-finalizationReserveMs;
    const departureMutationDeadlineEpochMs=phaseDeadlineEpochMs;
    const phaseBudgetsMs={
      supplies:90000,
      maintenance:180000,
      campaign:120000,
      fleetDemand:180000,
      routeExecution:MUTATION_PHASE_START_MINIMUM_MS,
      ticketPricing:MUTATION_PHASE_START_MINIMUM_MS,
      departures:MUTATION_PHASE_START_MINIMUM_MS,
    } as const;
    const phaseBudgetDecisions:Array<ReturnType<typeof evaluateRunPhaseBudget>>=[];
    const recordPhaseBudget=()=> {
      const dir='test-results/demand';fs.mkdirSync(dir,{recursive:true});
      const file=path.join(dir,'run-time-budget.json');
      fs.writeFileSync(file,JSON.stringify({schemaVersion:1,runStartedEpochMs,runTimeoutMs,finalizationReserveMs,phaseDeadlineEpochMs,decisions:phaseBudgetDecisions},null,2)+'\n');
      const rows=phaseBudgetDecisions.map(d=>`| ${d.phase} | ${d.allowed?'ALLOW':'HOLD'} | ${d.reason} | ${d.remainingMs} | ${d.minimumPhaseMs} |`).join('\n');
      fs.writeFileSync(path.join(dir,'run-time-budget.md'),`## Orçamento seguro de execução\n\n| Fase | Decisão | Motivo | Restante (ms) | Mínimo (ms) |\n|---|---|---|---:|---:|\n${rows || '| - | - | - | - | - |'}\n`);
    };
    const phaseAllowed=(phase:string,minimumPhaseMs:number)=>{
      const decision=evaluateRunPhaseBudget(phase,Date.now(),phaseDeadlineEpochMs,minimumPhaseMs);
      phaseBudgetDecisions.push(decision);recordPhaseBudget();
      if(!decision.allowed) console.warn(`[Budget] ${phase}: ${decision.reason} (remainingMs=${decision.remainingMs}, minimumPhaseMs=${decision.minimumPhaseMs}).`);
      return decision.allowed;
    };

    const moduleEnabled = (name: string, defaultValue = true) => {
      const raw = (process.env[name] || '').trim().toLowerCase();
      if (!raw) return defaultValue;
      return !['false', '0', 'off', 'no'].includes(raw);
    };

    const campaignRequired = moduleEnabled('ENABLE_CAMPAIGN');
    let campaignVerifiedForDeparture = !campaignRequired;

    const recordOperationalModule = (module:'maintenance'|'campaign',status:'started_observed'|'completed_observed'|'held_safe'|'verified_active'|'unverified',evidence?:Record<string,unknown>) => {
      const dir='test-results/demand',file=path.join(dir,'operational-modules.json');fs.mkdirSync(dir,{recursive:true});
      let current:any={schemaVersion:1};try{current=JSON.parse(fs.readFileSync(file,'utf8'));}catch{}
      current.schemaVersion=1;current[module]={status,observedAt:new Date().toISOString(),...(evidence?{evidence}: {})};
      fs.writeFileSync(file,JSON.stringify(current,null,2)+'\n');
    };

    const closeOpenPanel = async (context = 'painel') => {
      const popup = page.locator('#popup.modal.show').first();

      const popupVisible = async () =>
        popup.isVisible({ timeout: 500 }).catch(() => false);

      const waitPopupClosed = async (timeout = 1500) =>
        popup.waitFor({ state: 'hidden', timeout }).then(() => true).catch(() => false);

      if (await popupVisible()) {
        console.log(`[UI] Modal bloqueante detectado (${context}); tentando fechar com seguranca...`);

        // 1. Bootstrap/modais convencionais normalmente respondem ao Escape.
        await page.keyboard.press('Escape').catch(() => undefined);
        await waitPopupClosed();

        // 2. Procura apenas controles explicitamente reconhecidos como fechamento.
        if (await popupVisible()) {
          const dismissSelectors = [
            '#popup.modal.show [data-dismiss="modal"]',
            '#popup.modal.show [data-bs-dismiss="modal"]',
            '#popup.modal.show .btn-close',
            '#popup.modal.show button.close'
          ];

          for (const selector of dismissSelectors) {
            const dismiss = page.locator(selector).first();
            if (await dismiss.isVisible({ timeout: 300 }).catch(() => false)) {
              await dismiss.click({ timeout: 3000 }).catch(() => undefined);
              if (await waitPopupClosed()) break;
            }
          }
        }

        // 3. Usa a propria funcao da interface do AM4, a mesma chamada pelo menu Fleet.
        if (await popupVisible()) {
          const appDismissed = await page.evaluate(() => {
            const fn = (window as any).hideAllWhenClick;
            if (typeof fn !== 'function') return false;
            fn();
            return true;
          }).catch(() => false);

          if (appDismissed) await waitPopupClosed(2500);
        }

        // Nunca espera o timeout global de 15 minutos por um popup interceptando cliques.
        if (await popupVisible()) {
          await page.screenshot({
            path: 'test-results/blocking-popup.png',
            fullPage: true
          }).catch(() => undefined);
          throw new Error(`[UI] Nao foi possivel fechar #popup antes de ${context}.`);
        }

        console.log(`[UI] Modal bloqueante fechado (${context}).`);
      }

      // Fecha paineis laterais comuns por uma area neutra conhecida da interface.
      await assertNoInteractiveChallenge(page,'ui:before-close-panel');
      await page.mouse.click(400, 20);
      await GeneralUtils.randomSleep(500, 900);

      // Um modal pode aparecer/continuar aberto depois do clique fora; nao segue silenciosamente.
      if (await popupVisible()) {
        const appDismissed = await page.evaluate(() => {
          const fn = (window as any).hideAllWhenClick;
          if (typeof fn !== 'function') return false;
          fn();
          return true;
        }).catch(() => false);
        if (appDismissed) await waitPopupClosed(2500);
      }

      if (await popupVisible()) {
        await page.screenshot({
          path: 'test-results/blocking-popup.png',
          fullPage: true
        }).catch(() => undefined);
        throw new Error(`[UI] #popup continua bloqueando a interface antes de ${context}.`);
      }
    };

    const runDemandMaintenance = async () => {
      if (!moduleEnabled('ENABLE_MAINTENANCE')) {
        console.log('[Configuracao] Manutencao automatica desativada.');
        return;
      }
      if (demandConfig.dryRun) {
        console.log('[Demand] Simulacao ativa: manutencao nao sera executada.');
        return;
      }

      console.log('[Operacao] Iniciando manutencao preventiva, A-checks e reparos...');
      recordOperationalModule('maintenance','started_observed');
      const maintenanceUtils = new MaintenanceUtils(page);
      const maintenanceMenu = page.locator('div:nth-child(4) > #mapMaint > img');

      await closeOpenPanel('abrir manutencao');
      await GeneralUtils.moveAndClick(page, maintenanceMenu, 20000);
      await page.getByRole('button', { name: ' Plan' })
        .waitFor({ state: 'visible', timeout: 15000 });

      try {
        const checkEvidence=await maintenanceUtils.checkPlanes();
        await GeneralUtils.randomSleep(1500, 3000);
        const repairEvidence=await maintenanceUtils.repairPlanes();
        await GeneralUtils.randomSleep(1500, 3000);
        await closeOpenPanel('finalizar manutencao');
        console.log('[Operacao] Manutencao automatica finalizada.');
        recordOperationalModule('maintenance','completed_observed',{...checkEvidence,...repairEvidence});
      } catch (error) {
        const reason=(error as Error)?.message;
        if(reason!=='UI_CONTROL_OBSCURED') throw error;
        console.warn('[Manutencao] HOLD seguro: controle de manutencao encoberto; nenhuma acao forcada foi executada.');
        recordOperationalModule('maintenance','held_safe',{reason:'UI_CONTROL_OBSCURED',mutationAuthorized:false});
        await closeOpenPanel('encerrar manutencao em HOLD seguro');
      }
    };

    const runDemandCampaign = async (): Promise<boolean> => {
      if (!campaignRequired) {
        console.log('[Configuracao] Campanhas automaticas desativadas; gate de campanha nao e exigido.');
        campaignVerifiedForDeparture = true;
        return true;
      }
      if (demandConfig.dryRun) {
        console.log('[Demand] Simulacao ativa: campanhas nao serao contratadas.');
        return false;
      }

      console.log('[Operacao] Verificando e contratando campanhas...');
      recordOperationalModule('campaign','started_observed');
      const campaignUtils = new CampaignUtils(page);
      const marketingButton = page.getByRole('button', { name: /Marketing/i }).first();
      const campaignMenuCandidates = page.locator('div:nth-child(5) > #mapMaint > img');

      try {
        await closeOpenPanel('abrir campanhas');
        if (!(await marketingButton.isVisible({ timeout: 500 }).catch(() => false))) {
          let opened=false,lastReason='CAMPAIGN_MENU_NOT_VISIBLE';
          const count=await campaignMenuCandidates.count();
          for(let i=0;i<count;i++){
            const candidate=campaignMenuCandidates.nth(i);
            if(!(await candidate.isVisible({timeout:300}).catch(()=>false)))continue;
            try{
              await GeneralUtils.moveAndClick(page,candidate,5000);
              await marketingButton.waitFor({ state:'visible',timeout:4000 });
              opened=true;break;
            }catch(error){
              const reason=(error as Error)?.message||'UNCLASSIFIED';
              if(reason==='INTERACTIVE_CHALLENGE_DETECTED_STOP')throw error;
              lastReason=reason;
              if(reason!=='UI_CONTROL_OBSCURED')break;
            }
          }
          if(!opened)throw new Error('CAMPAIGN_MENU_OPEN_FAILED:'+lastReason);
        }

        const evidence = await campaignUtils.createCampaign();
        await GeneralUtils.randomSleep(700, 1200);
        await closeOpenPanel('finalizar campanhas');

        campaignVerifiedForDeparture = evidence.allRequiredVerified;
        if (evidence.allRequiredVerified) {
          console.log('[Campaign] Todas as campanhas exigidas foram confirmadas como ativas.');
          recordOperationalModule('campaign','verified_active',evidence as unknown as Record<string,unknown>);
          return true;
        }

        console.warn('[Campaign] Campanha exigida nao foi confirmada; decolagens ficarao em HOLD.');
        recordOperationalModule('campaign','unverified',evidence as unknown as Record<string,unknown>);
        return false;
      } catch (error) {
        const reason=(error as Error)?.message || 'UNCLASSIFIED';
        if(reason==='INTERACTIVE_CHALLENGE_DETECTED_STOP') throw error;
        campaignVerifiedForDeparture=false;
        console.warn('[Campaign] Validacao incompleta; decolagens ficarao em HOLD: '+reason);
        recordOperationalModule('campaign','unverified',{
          reason,
          allRequiredVerified:false,
          departureAuthorized:false
        });
        await closeOpenPanel('encerrar campanhas sem confirmacao').catch(()=>undefined);
        return false;
      }
    };

    await loginForReadOnlyCollection(page, process.env, 90000);
    await test.step('UI health pre-mutation', async()=>await runInitialUiHealthCheck(page));

    // Mantem o modulo novo de abastecimento e reincorpora as funcoes da fork original,
    // mas nunca inicia uma fase cara quando ja nao existe janela conservadora para conclui-la.
    if (phaseAllowed('supplies',phaseBudgetsMs.supplies)) await runSupplies(page, demandConfig.dryRun);
    if (phaseAllowed('maintenance',phaseBudgetsMs.maintenance)) await test.step('Manutencao e reparos', runDemandMaintenance);
    if (phaseAllowed('campaign',phaseBudgetsMs.campaign)) {
      await test.step('Campanhas de marketing', runDemandCampaign);
    } else if (!demandConfig.dryRun && campaignRequired) {
      campaignVerifiedForDeparture=false;
      recordOperationalModule('campaign','unverified',{
        reason:'RUN_TIME_BUDGET_EXHAUSTED_BEFORE_CAMPAIGN_VERIFICATION',
        allRequiredVerified:false,
        departureAuthorized:false
      });
    }
    if (!phaseAllowed('fleet-demand',phaseBudgetsMs.fleetDemand)) {
      console.warn('[Budget] Coleta Fleet/Demand nao iniciada; nenhuma fase mutavel posterior sera executada.');
      return;
    }

    const fleetMenu = page.locator('#mapRoutes');
    if (await fleetMenu.count() !== 1 || !await fleetMenu.isVisible() ||
      (await fleetMenu.getAttribute('onclick') || '').replace(/\s/g, '') !== "hideAllWhenClick();menuFleet('Routes');") {
      throw new Error('[Demand] Menu Fleet nao confirmado; nenhuma operacao autorizada.');
    }

    await closeOpenPanel('abrir Fleet/Routes');

    let fleetOpened = false;
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        // Timeout curto evita consumir os 15 minutos do teste caso um modal volte a interceptar.
        await fleetMenu.click({ timeout: 15000 });
        fleetOpened = true;
        break;
      } catch (error) {
        console.warn(`[UI] Falha ao abrir Fleet/Routes (tentativa ${attempt}/2).`);
        if (attempt === 2) throw error;
        await closeOpenPanel('recuperar abertura de Fleet/Routes');
      }
    }

    if (!fleetOpened) {
      throw new Error('[Demand] Fleet/Routes nao abriu apos recuperacao da interface.');
    }
    const simulation = await runDemandSimulationDetailed(page, demandConfig, {}, {collectionRetryDeadlineEpochMs:phaseDeadlineEpochMs});
    let routeExecutionReport: Awaited<ReturnType<typeof runRouteExecution>> | null = null;
    let pricingExecutionReport: Awaited<ReturnType<typeof runTicketPricingExecution>> | null = null;
    if (process.env.AUTOMATION_MODE === 'semi-automatic') {
      await writeSemiAutomaticSummary(simulation);
      console.log('[SemiAutomatic] Analise concluida. Nenhuma mutacao no jogo foi autorizada; execucao real exige confirmacao manual.');
    }
    if (!demandConfig.dryRun && moduleEnabled('ENABLE_ROUTE_EXECUTION', false)
      && phaseAllowed('route-execution',phaseBudgetsMs.routeExecution)) {
      routeExecutionReport = await test.step(
        'Reroute conservador por aeronave',
        async () => await runRouteExecution(page, simulation,{
          ...process.env,
          ROUTE_EXECUTION_MUTATION_DEADLINE_EPOCH_MS:String(phaseDeadlineEpochMs)
        })
      );
    }
    if (!demandConfig.dryRun && moduleEnabled('ENABLE_TICKET_PRICING_EXECUTION', false)
      && phaseAllowed('ticket-pricing',phaseBudgetsMs.ticketPricing)) {
      pricingExecutionReport = await test.step(
        'Ajustar tarifas por rota',
        async () => await runTicketPricingExecution(page,{
          ...process.env,
          TICKET_PRICING_MUTATION_DEADLINE_EPOCH_MS:String(phaseDeadlineEpochMs)
        })
      );
    }
    const departureEnabled = !demandConfig.dryRun && moduleEnabled('ENABLE_DEPART');
    const departureBudgetAllowed = departureEnabled && phaseAllowed('departures',phaseBudgetsMs.departures);
    if (isSkippedDeparturePhaseFailure(departureEnabled,departureBudgetAllowed,simulation.report.summary.sufficient)) {
      // A live run that found sufficient demand must not finish green when its
      // departure phase is skipped for lack of time (no click is performed).
      console.error('[DepartureRuntime] Coleta apontou demanda suficiente, mas nao restou tempo para iniciar decolagens.');
      throw new Error('DEMAND_EXECUTION_BUDGET_EXHAUSTED_BEFORE_DISPATCH');
    }
    if (departureBudgetAllowed) {
      const reroutedAircraftIds=new Set(
        (routeExecutionReport?.entries||[]).filter(e=>e.status==='rerouted').map(e=>e.aircraftId)
      );
      const pricingVerifiedAircraftIds=new Set(
        (pricingExecutionReport?.entries||[])
          .filter(e=>e.status==='adjusted'||e.status==='unchanged')
          .map(e=>e.aircraftId)
      );
      const postReroutePricingBlockedAircraftIds=new Set(
        [...reroutedAircraftIds].filter(id=>!pricingVerifiedAircraftIds.has(id))
      );
      const currentRouteFuelEvidence=new Map(
        (simulation.candidateData.demandLabelCalibration?.samples||[])
          .flatMap(sample=>{
            const quote=sample.currentRouteQuote;
            if(!quote||quote.aircraftId!==sample.aircraftId||quote.from!==sample.from||quote.to!==sample.to||
              !Number.isSafeInteger(quote.fuelLbs)||quote.fuelLbs<=0)return [];
            return [[sample.aircraftId,{
              aircraftId:sample.aircraftId,routeId:sample.routeId,from:sample.from,to:sample.to,
              fuelLbs:quote.fuelLbs,observedAt:quote.observedAt
            }] as const];
          })
      );
      if(postReroutePricingBlockedAircraftIds.size){
        console.warn('[Departure] Reroute confirmado sem pricing fresco confirmado; aeronaves em HOLD: '+
          [...postReroutePricingBlockedAircraftIds].join(','));
      }
      const dispatchReport=await runDemandExecution(page,demandConfig,{
        ...process.env,
        CAMPAIGN_GATE_REQUIRED: campaignRequired ? 'true' : 'false',
        CAMPAIGN_GATE_VERIFIED: campaignVerifiedForDeparture ? 'true' : 'false',
        DEMAND_EXECUTION_MUTATION_DEADLINE_EPOCH_MS:String(departureMutationDeadlineEpochMs)
      },'test-results/demand',{
        postReroutePricingBlockedAircraftIds,currentRouteFuelEvidence,
        // Route mutation invalidates the earlier inventory. Otherwise reuse
        // its already-verified identities, and re-read every target fresh.
        verifiedFleetSnapshot:reroutedAircraftIds.size===0?simulation.collection:undefined
      });
      const postSupplyGate=postDispatchSupplyDecision(dispatchReport);
      const postSupplyBudget=phaseAllowed('post-dispatch-supplies',phaseBudgetsMs.supplies);
      console.log('[PostDispatchSupplies] '+JSON.stringify({
        eligible:postSupplyGate.allowed,reason:postSupplyGate.reason,budgetAllowed:postSupplyBudget
      }));
      // The departure executor throws on time starvation or any unknown click.
      // This stage never runs on a partial/uncertain departure cycle.
      if(postSupplyGate.allowed&&postSupplyBudget&&moduleEnabled('ENABLE_FUEL')){
        await runSupplies(page,false,process.env,'test-results/demand',undefined,{
          phase:'post',mutationDeadlineEpochMs:phaseDeadlineEpochMs
        });
      }
    }
    return;
  }
  // Timeout ampliado para navegacao e atualizacoes assíncronas da interface.
  test.setTimeout(600000);

  // ==============================================================
  // ⏱️ LOGIKA AUTOMATIC KEEPALIVE LOG (.TXT) - HANYA 1X DI TANGGAL 1
  // ==============================================================
  const hariIni = new Date();
  const tanggalUTC = hariIni.getUTCDate();

  if (tanggalUTC === 1) {
    const formatBulanIni = `${hariIni.getUTCFullYear()}-${String(hariIni.getUTCMonth() + 1).padStart(2, '0')}`;
    const logFilePath = path.join(__dirname, '../last-commit.txt'); 

    let sudahCommitBulanIni = false;

    if (fs.existsSync(logFilePath)) {
      const isiLog = fs.readFileSync(logFilePath, 'utf8');
      if (isiLog.includes(formatBulanIni)) {
        sudahCommitBulanIni = true;
      }
    }

    if (!sudahCommitBulanIni) {
      console.log(`[Keepalive] Primeira execucao do dia 1 detectada. Atualizando registro do mes: ${formatBulanIni}`);
      const kontenLogBaru = `Last Successful Keepalive Commit: ${formatBulanIni} (Executed at: ${hariIni.toISOString()} WIB/UTC)\n`;
      fs.writeFileSync(logFilePath, kontenLogBaru, 'utf8');
      console.log("[Keepalive] Arquivo last-commit.txt atualizado. O workflow registrara o commit.");
    } else {
      console.log(`[Keepalive] Bot ja registrou atividade no mes ${formatBulanIni}; nenhuma atualizacao necessaria.`);
    }
  } else {
    console.log(`[Keepalive] Hoje e dia ${tanggalUTC} UTC. Atualizacao mensal dispensada.`);
  }
  // ==============================================================

  // Variable Initialization
  const fuelUtils = new FuelUtils(page);
  const generalUtils = new GeneralUtils(page);
  const campaignUtils = new CampaignUtils(page);
  const fleetUtils = new FleetUtils(page);
  const maintenanceUtils = new MaintenanceUtils(page);
  // End //

  /** Fecha o painel lateral clicando em uma area neutra conhecida da interface. */
  const clickBlankSpaceTop = async () => {
    console.log('Clicando fora do painel para fechar o menu...');
    await assertNoInteractiveChallenge(page,'legacy-ui:before-close-panel');
    await page.mouse.click(400, 20);
    await GeneralUtils.randomSleep(300, 600);
  };

  // Controles principais usados na recuperacao de interface.
  const menuTiles: Record<string, import('@playwright/test').Locator> = {
    fuel: page.locator('#mapMaint > img').first(),
    maintenance: page.locator('div:nth-child(4) > #mapMaint > img'),
    campaign: page.locator('div:nth-child(5) > #mapMaint > img'),
    depart: page.locator('#mapRoutes').getByRole('img')
  };

  // Recupera a interface abrindo e fechando outro menu quando o painel nao responde.
  const triggerRandomMenuPoke = async (currentMenuKey: string) => {
    const keys = Object.keys(menuTiles).filter(key => key !== currentMenuKey);
    const randomKey = keys[Math.floor(Math.random() * keys.length)];
    
    console.log(`[Recuperacao] Tentando atualizar a interface por meio do menu [${randomKey}]...`);
    await clickBlankSpaceTop();
    await GeneralUtils.randomSleep(1000, 1800);
    
    // Usa o helper padrao de clique.
    await GeneralUtils.moveAndClick(page, menuTiles[randomKey]);
    await GeneralUtils.randomSleep(2000, 3500);
    
    // Keluar seketika tanpa melakukan operasi apa pun di dalamnya
    await clickBlankSpaceTop();
    await GeneralUtils.randomSleep(1200, 2000);
  };

  // 1. Login normal pela interface.
  await generalUtils.login(page);
  await GeneralUtils.randomSleep(5000, 8000);

  // ==================== DEFINISI FUNGSI MODUL ====================

  const runFuel = async (attempt = 1) => {
    console.log(`[Operacao] Iniciando combustivel e CO2 (tentativa ${attempt})...`);
    const currentBalance = await fuelUtils.getCurrentBalance();
    console.log('[Operacao] Saldo antes de abrir combustivel: ' + currentBalance);

    // Abre o menu de Fuel pela interface.
    await GeneralUtils.moveAndClick(page, menuTiles.fuel);
    await GeneralUtils.randomSleep(2000, 4000);

    try {
      // Validasi penanda halaman fuel sukses dimuat
      await page.getByPlaceholder('Amount to purchase').waitFor({ state: 'visible', timeout: 8000 });
    } catch (error) {
      console.log('[Operacao] Painel de combustivel nao abriu ou travou.');
      if (attempt < 2) {
        await triggerRandomMenuPoke('fuel');
        await runFuel(attempt + 1);
        return;
      } else {
        throw new Error('Painel de combustivel nao carregou apos nova tentativa.');
      }
    }
    
    await fuelUtils.buyFuel();
    await GeneralUtils.randomSleep(1500, 3000);

    // Abre a aba de CO2 pela interface.
    const co2TabButton = page.getByRole('button', { name: ' Co2' });
    await GeneralUtils.moveAndClick(page, co2TabButton);
    await GeneralUtils.randomSleep(2000, 4000);
    
    await fuelUtils.buyCo2();
    await GeneralUtils.randomSleep(1500, 3000);

    await clickBlankSpaceTop();
    console.log('[Operacao] Combustivel e CO2 finalizados.');
  };

  const runMaintenance = async (attempt = 1) => {
    console.log(`[Operacao] Iniciando manutencao e reparos (tentativa ${attempt})...`);
    await clickBlankSpaceTop();
    await GeneralUtils.randomSleep(1000, 1800);

    // Abre o menu de manutencao pela interface.
    await GeneralUtils.moveAndClick(page, menuTiles.maintenance);

    try {
      await page.getByRole('button', { name: ' Plan' }).waitFor({ state: 'visible', timeout: 15000 });
    } catch (error) {
      console.log('[Operacao] Painel de manutencao nao abriu ou travou.');
      if (attempt < 2) {
        await triggerRandomMenuPoke('maintenance');
        await runMaintenance(attempt + 1);
        return;
      } else {
        throw new Error('Painel de manutencao nao carregou apos nova tentativa.');
      }
    }

    await GeneralUtils.randomSleep(1200, 2200);
    await maintenanceUtils.checkPlanes();
    await GeneralUtils.randomSleep(2000, 4000);
    
    await maintenanceUtils.repairPlanes();
    await GeneralUtils.randomSleep(2000, 4000);

    await clickBlankSpaceTop();
    console.log('[Operacao] Manutencao finalizada.');
  };

  const runCampaign = async (attempt = 1) => {
    console.log(`[Operacao] Iniciando campanhas antes das decolagens (tentativa ${attempt})...`);
    
    // Abre o menu de campanhas pela interface.
    await GeneralUtils.moveAndClick(page, menuTiles.campaign);
    await GeneralUtils.randomSleep(2500, 4500);

    try {
      // Pastikan tombol internal marketing siap diakses
      await page.getByRole('button', { name: ' Marketing' }).waitFor({ state: 'visible', timeout: 8000 });
    } catch (error) {
      console.log('[Operacao] Painel de campanhas nao abriu ou travou.');
      if (attempt < 2) {
        await triggerRandomMenuPoke('campaign');
        await runCampaign(attempt + 1);
        return;
      } else {
        throw new Error('Painel de campanhas nao carregou apos nova tentativa.');
      }
    }
    
    await campaignUtils.createCampaign();
    await GeneralUtils.randomSleep(1500, 3000);

    await clickBlankSpaceTop();
    console.log('[Operacao] Campanhas finalizadas.');
  };

  const runDepart = async () => {
    console.log('[Operacao] Iniciando decolagem de todas as aeronaves...');

    await clickBlankSpaceTop();
    await GeneralUtils.randomSleep(1000, 2000);

    try {
      await GeneralUtils.moveAndClick(page, menuTiles.depart, 20000);
      await GeneralUtils.randomSleep(2000, 3000);

      await fleetUtils.departPlanes();
      console.log('[Operacao] Comando de decolagem executado. Confira a frota.');
    } catch (error) {
      console.error('[Operacao] FALHA NAS DECOLAGENS:', error);
      await page.screenshot({
        path: 'test-results/depart-error.png',
        fullPage: true
      });
      throw error;
    }

    await clickBlankSpaceTop();
  };

  // ==================== ORDEM DOS MODULOS LEGADOS ====================
  const initialTasks = [runFuel, runMaintenance];

  // Mantem compatibilidade com a ordem dinamica do fluxo legado.
  for (let i = initialTasks.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [initialTasks[i], initialTasks[j]] = [initialTasks[j], initialTasks[i]];
  }

  // Modulos podem ser desligados em Settings > Secrets and variables > Actions.
  // Variavel ausente significa ativado, preservando o comportamento existente.
  const enabled = (name: string) =>
    !['false', '0', 'off', 'no'].includes((process.env[name] || '').trim().toLowerCase());

  const flags = {
    fuel: enabled('ENABLE_FUEL'),
    maintenance: enabled('ENABLE_MAINTENANCE'),
    campaign: enabled('ENABLE_CAMPAIGN'),
    depart: enabled('ENABLE_DEPART'),
  };
  console.log('[Configuracao] Modulos ativados:', JSON.stringify(flags));

  // Usar test.step facilita identificar a etapa que falhou nos relatorios.
  console.log('--- Iniciando operacoes da companhia aerea ---');
  const selectedTasks = initialTasks.filter(task =>
    (task === runFuel && flags.fuel) ||
    (task === runMaintenance && flags.maintenance)
  );

  for (const task of selectedTasks) {
    const name = task === runFuel ? 'Combustivel e CO2' : 'Manutencao';
    await test.step(name, async () => await task());
    await GeneralUtils.randomSleep(5000, 9000);
  }

  if (flags.campaign) {
    await test.step('Campanhas', async () => await runCampaign());
    await GeneralUtils.randomSleep(5000, 8000);
  } else {
    console.log('[Configuracao] Campanhas desativadas.');
  }

  if (flags.depart) {
    await test.step('Decolagens', async () => await runDepart());
  } else {
    console.log('[Configuracao] Decolagens desativadas.');
  }

  console.log('--- Rotina de operacoes concluida ---');
  await GeneralUtils.randomSleep(1000, 2000);
  await page.close();
  });
});
