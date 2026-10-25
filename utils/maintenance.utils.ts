import { Page } from "@playwright/test";
import { GeneralUtils } from "./general.utils";
import { assertNoInteractiveChallenge } from "./challenge-guard";

require('dotenv').config();

/** Never derive a maintenance deadline from an unrelated card number. */
export function parseMaintenanceHoursToCheck(cardText:string):number|null {
    const matches=Array.from(cardText.matchAll(/\bhours\s+to\s+check\s*:?\s*(\d{1,6})(?![\d.,])/gi));
    if(matches.length!==1)return null;
    const hours=Number(matches[0][1]);
    return Number.isSafeInteger(hours)&&hours>=0?hours:null;
}

export class MaintenanceUtils {
    page: Page;
    repairWear: string;
    hoursCheck: number;

    constructor(page: Page) {
        this.page = page;

        const configuredRepairWear = parseInt(process.env.REPAIR_WEAR || '30', 10);
        const configuredHoursCheck = parseInt(process.env.HOURS_CHECK || '20', 10);

        this.repairWear =
            Number.isFinite(configuredRepairWear) && configuredRepairWear > 0
                ? String(configuredRepairWear)
                : '30';
        this.hoursCheck =
            Number.isFinite(configuredHoursCheck) && configuredHoursCheck >= 0
                ? configuredHoursCheck
                : 20;
    }

    /** Opens the maintenance planning panel using the normal UI control. */
    public async openPlanPanel(recoverObscuredPlan?:()=>Promise<void>) {
        const planButton = this.page.getByRole('button', { name: ' Plan' });
        try {
            await GeneralUtils.moveAndClick(this.page, planButton, 15000);
        } catch(error) {
            // A single recovery is allowed for READ-ONLY menu navigation only.
            // Never retry card selection, bulk check, repair or a purchase.
            if(!(error instanceof Error)||error.message!=='UI_CONTROL_OBSCURED'||!recoverObscuredPlan)
                throw error;
            console.warn('[Manutencao] Plan encoberto: recuperacao unica de navegacao, sem repetir servicos.');
            await assertNoInteractiveChallenge(this.page,'maintenance:plan-readonly-recovery');
            await recoverObscuredPlan();
            await assertNoInteractiveChallenge(this.page,'maintenance:plan-after-recovery');
            if(await planButton.count()!==1 || !await planButton.isVisible())
                throw new Error('UI_CONTROL_OBSCURED');
            await GeneralUtils.moveAndClick(this.page,planButton,15000);
        }
    }

    /** Selects an option through the native select element. */
    private async moveAndSelectOption(selectLocator: any, optionValue: string) {
        await assertNoInteractiveChallenge(this.page, 'maintenance:before-select');
        await selectLocator.waitFor({ state: 'visible', timeout: 10000 });
        await selectLocator.selectOption(optionValue);
    }

    private async scrollBackToTop() {
        await this.page.evaluate(() => window.scrollTo(0, 0)).catch(() => undefined);
        await GeneralUtils.randomSleep(300, 600);
    }

    public async repairPlanes():Promise<{repairEligible:boolean}> {
        await this.openPlanPanel();
        await GeneralUtils.randomSleep(1000, 2000);
        
        const bulkRepairButton = this.page.getByRole('button', { name: ' Bulk repair' });
        await GeneralUtils.moveAndClick(this.page, bulkRepairButton);
        await GeneralUtils.randomSleep(1200, 2200);
        
        console.log(`Selecionando limite de desgaste para reparo: ${this.repairWear}%...`);
        const repairPercentSelect = this.page.locator('#repairPct');
        await this.moveAndSelectOption(repairPercentSelect, this.repairWear);
        await GeneralUtils.randomSleep(1200, 2500);
        
        const noPlaneExists = await this.page.getByText('There are no aircraft worn to').isVisible();
        if (!noPlaneExists) {
            const planBulkRepairButton = this.page.getByRole('button', { name: 'Plan bulk repair' });
            await GeneralUtils.moveAndClick(this.page, planBulkRepairButton);
        }
        return {repairEligible:!noPlaneExists};
    }

    public async checkPlanes(recoverObscuredPlan?:()=>Promise<void>):Promise<{evaluated:number;selected:number;bulkCheckExecuted:boolean}> {
        await this.openPlanPanel(recoverObscuredPlan);
        await GeneralUtils.randomSleep(1000, 2000);
        
        const bulkCheckButton = this.page.getByRole('button', { name: ' Bulk check' });
        await GeneralUtils.moveAndClick(this.page, bulkCheckButton);
        
        await GeneralUtils.randomSleep(3000, 4500);
        
        let clicked = false;
        let selected = 0;
        let didScroll = false; 

        // Percorre o painel para garantir que os cards estejam carregados.
        console.log("[Manutencao] Percorrendo painel para carregar todas as aeronaves...");
        for (let s = 0; s < 5; s++) {
            await this.page.mouse.wheel(0, 450);
            await GeneralUtils.randomSleep(200, 450);
        }
        await GeneralUtils.randomSleep(1000, 1500);

        // Retorna ao inicio antes de avaliar os cards.
        await this.page.mouse.wheel(0, -2500);
        await GeneralUtils.randomSleep(800, 1200);

        // Conta os cards de aeronaves observados.
        let cardsCount = await this.page.locator('.bg-white').count();
        console.log(`[Manutencao] Avaliando ${cardsCount} aeronaves (limite: ate ${this.hoursCheck} horas)...`);

        // Avalia cada card uma unica vez.
        for (let i = 0; i < cardsCount; i++) {
            // Recria o locator em cada iteracao para evitar referencia obsoleta.
            const cardElement = this.page.locator('.bg-white').nth(i);
            
            // Pengaman: Tunggu kartu terpasang dengan benar di DOM sebelum mengecek isinya
            try {
                await cardElement.waitFor({ state: 'attached', timeout: 3000 });
            } catch (e) {
                console.log(`[Aviso] Aeronave de indice ${i} indisponivel. Continuando para a proxima.`);
                continue;
            }

            // Jika kartu belum masuk ke area layar aktif, scroll perlahan ke posisinya
            if (!(await cardElement.isVisible())) {
                await cardElement.scrollIntoViewIfNeeded();
                await GeneralUtils.randomSleep(300, 600);
                if (!(await cardElement.isVisible())) continue;
            }

            // Ambil text isi kartu secara keseluruhan untuk membaca sisa jam terbang
            const cardText = await cardElement.innerText();
            
            // Without an exact Hours to check label the aircraft stays in HOLD.
            // A number in a registration/flight-hour field or red styling
            // is not independently verified remaining maintenance time.
            const hoursRemaining=parseMaintenanceHoursToCheck(cardText);
            if(hoursRemaining===null){
                console.warn('[Preventivo] HOLD: Hours to check nao verificado no card '+i+'.');
                continue;
            }
            const harusDiCheck=hoursRemaining<=this.hoursCheck;
            const alasan=`Restam ${hoursRemaining} horas (limite de ${this.hoursCheck} horas) [Leitura verificada]`;

            // Eksekusi klik jika memenuhi syarat evaluasi di atas
            if (harusDiCheck) {
                console.log(`[Preventivo] Selecionada aeronave de indice ${i} pelo motivo: ${alasan}`);

                // Garante que o card esteja visivel antes do clique.
                await cardElement.scrollIntoViewIfNeeded();
                await GeneralUtils.randomSleep(400, 800);

                const boxBefore = await cardElement.boundingBox();
                const viewport = this.page.viewportSize();
                if (boxBefore && viewport && (boxBefore.y + boxBefore.height > viewport.height || boxBefore.y < 0)) {
                    didScroll = true; 
                }

                await GeneralUtils.moveAndClick(this.page, cardElement);
                clicked = true;
                selected++;

                // Aguarda a atualizacao do DOM antes de avaliar o proximo card.
                await GeneralUtils.randomSleep(1500, 2500);
            }
        }

        if (clicked) {
            if (didScroll) {
                await this.scrollBackToTop();
            } else {
                await GeneralUtils.randomSleep(1000, 2000);
            }
            
            const planBulkCheckButton = this.page.getByRole('button', { name: 'Plan bulk check' });
            await GeneralUtils.moveAndClick(this.page, planBulkCheckButton);
            console.log("[Manutencao] Verificacoes em lote executadas.");
        } else {
            console.log("[Preventivo] Finalizado. Aeronaves acima do limite de horas para revisao.");
        }
        return {evaluated:cardsCount,selected,bulkCheckExecuted:clicked};
    }
}

