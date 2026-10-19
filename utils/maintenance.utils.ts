import { Page } from "@playwright/test";
import { GeneralUtils } from "./general.utils";
import { assertNoInteractiveChallenge } from "./challenge-guard";

require('dotenv').config();

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
    private async openPlanPanel() {
        const planButton = this.page.getByRole('button', { name: ' Plan' });
        await GeneralUtils.moveAndClick(this.page, planButton, 15000);
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

    public async checkPlanes():Promise<{evaluated:number;selected:number;bulkCheckExecuted:boolean}> {
        await this.openPlanPanel();
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
                // A lista mudou durante a selecao: nao afirmar manutencao completa
                // nem executar o bulk check com uma aeronave nao inspecionada.
                console.warn(`[Manutencao] Cartao de indice ${i} indisponivel; interrompendo verificacao em HOLD seguro.`);
                throw new Error('MAINTENANCE_CARD_UNAVAILABLE');
            }

            // Jika kartu belum masuk ke area layar aktif, scroll perlahan ke posisinya
            if (!(await cardElement.isVisible())) {
                try {
                    await cardElement.scrollIntoViewIfNeeded();
                    await GeneralUtils.randomSleep(300, 600);
                    if (!(await cardElement.isVisible())) throw new Error('MAINTENANCE_CARD_UNAVAILABLE');
                } catch {
                    console.warn(`[Manutencao] Cartao de indice ${i} invisivel; interrompendo verificacao em HOLD seguro.`);
                    throw new Error('MAINTENANCE_CARD_UNAVAILABLE');
                }
            }

            // Ambil text isi kartu secara keseluruhan untuk membaca sisa jam terbang
            const cardText = await cardElement.innerText();
            
            // Deteksi apakah teks jam terbang di dalam kartu ini sudah menyala merah (.text-danger)
            const hasDangerText = await cardElement.locator('.text-danger').count() > 0;
            
            // 🚀 PERBAIKAN REGEX BARU: Menangkap angka jam yang berada di BARIS BARU tepat setelah kalimat "Hours to check"
            const hourMatch = cardText.match(/hours\s*to\s*check\s*[\r\n\s]*(\d+)/i) || cardText.match(/(\d+)\s*(?=hr|hour|jam)/i);
            let hoursRemaining = null; 
            
            if (hourMatch) {
                hoursRemaining = parseInt(hourMatch[1], 10);
            } else {
                // Jalur cadangan jika teks "Hours to check" berganti bahasa, ambil angka pertama pada kartu
                const backupMatch = cardText.match(/\d+/);
                if (backupMatch) hoursRemaining = parseInt(backupMatch[0], 10);
            }

            // --- 📌 STRUKTUR LOGIKA PRIORITAS ---
            let harusDiCheck = false;
            let alasan = "";

            if (hoursRemaining !== null) {
                // PRIORITAS UTAMA: Jika nilai angka teks berhasil dibaca, jadikan acuan mutlak (Hijau/Merah bernilai sama)
                if (hoursRemaining <= this.hoursCheck) {
                    harusDiCheck = true;
                    alasan = `Restam ${hoursRemaining} horas (limite de ${this.hoursCheck} horas) [Leitura do painel]`;
                }
            } else if (hasDangerText) {
                // PRIORITAS CADANGAN: Hanya jika teks angka gagal terbaca sama sekali, gunakan warna merah sebagai fallback
                harusDiCheck = true;
                alasan = "Nao foi possivel ler as horas, mas foi identificado um alerta vermelho.";
            }

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

