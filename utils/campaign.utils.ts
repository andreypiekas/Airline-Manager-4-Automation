import { Page, Locator } from "@playwright/test";
import { GeneralUtils } from "./general.utils";
import { assertNoInteractiveChallenge } from "./challenge-guard";

export type CampaignItemStatus = 'already_active' | 'purchased_verified' | 'not_required' | 'unverified';

export interface CampaignItemEvidence {
    required: boolean;
    activeBefore: boolean;
    purchaseAttempted: boolean;
    verifiedActive: boolean;
    status: CampaignItemStatus;
    reason: string;
}

export interface CampaignEvidence {
    schemaVersion: 1;
    observedAt: string;
    ecoFriendly: CampaignItemEvidence;
    airlineReputation: CampaignItemEvidence;
    allRequiredVerified: boolean;
    departureAuthorized: boolean;
}

export class CampaignUtils {
    page: Page;
    increaseAirlineReputation = false;
    campaignType = 1;
    campaignDuration = 4;

    constructor(page: Page) {
        this.page = page;
        this.increaseAirlineReputation = (process.env.INCREASE_AIRLINE_REPUTATION || 'false').trim().toLowerCase() === 'true';
        const configuredType = parseInt(process.env.CAMPAIGN_TYPE || '1', 10);
        const configuredDuration = parseInt(process.env.CAMPAIGN_DURATION || '4', 10);
        this.campaignType = Number.isFinite(configuredType) && configuredType > 0 ? configuredType : 1;
        this.campaignDuration = Number.isFinite(configuredDuration) && configuredDuration > 0 ? configuredDuration : 4;
    }

    private async moveAndClick(locator: Locator) {
        await GeneralUtils.moveAndClick(this.page, locator);
    }

    private async moveAndSelectOption(selectLocator: Locator, optionValue: string) {
        await assertNoInteractiveChallenge(this.page, 'campaign:before-select');
        await selectLocator.waitFor({ state: 'visible', timeout: 10000 });
        await selectLocator.selectOption(optionValue);
    }

    private activeEcoLocator() {
        return this.page.locator('td:visible')
            .filter({ hasText: /^[^A-Za-z0-9]*Eco[\s-]+friendly\s*$/i })
            .first();
    }

    private activeReputationLocator() {
        return this.page.locator('td:visible')
            .filter({ hasText: /^[^A-Za-z0-9]*Airline\s+reputation\s*$/i })
            .first();
    }

    private async isVisible(locator: Locator, timeout = 500): Promise<boolean> {
        return locator.isVisible({ timeout }).catch(() => false);
    }

    private async campaignPanelVisible(): Promise<boolean> {
        return await this.isVisible(this.page.locator('button:visible').filter({ hasText: /New campaign/i }).first(), 300)
            || await this.isVisible(this.page.locator('#dSelector:visible').first(), 300)
            || await this.isVisible(this.page.locator('td:visible').filter({ hasText: /Eco[\s-]*friendly\s+Increases|Increase\s+airline\s+reputation|Campaign\s+\d+/i }).first(), 300);
    }

    private async verifyActive(locator: Locator, stage: string): Promise<boolean> {
        await assertNoInteractiveChallenge(this.page, stage);
        if (await this.isVisible(locator, 800)) return true;

        // If the Marketing content is already open, clicking the menu again can be
        // physically obscured by the popup itself. Never toggle a known-open panel.
        if (!await this.campaignPanelVisible()) {
            const marketingButton = this.page.getByRole('button', { name: /Marketing/i }).first();
            if (await this.isVisible(marketingButton, 800)) {
                await this.moveAndClick(marketingButton);
                await GeneralUtils.randomSleep(500, 900);
                await assertNoInteractiveChallenge(this.page, stage + ':after-refresh');
            }
        }

        return locator.waitFor({ state: 'visible', timeout: 5000 }).then(() => true).catch(() => false);
    }

    private async uniqueVisibleEcoOption(): Promise<Locator | null> {
        const cells=this.page.locator('td:visible');
        const matches:number[]=[];
        const count=await cells.count();
        for(let i=0;i<count;i++){
            const cell=cells.nth(i);
            const text=(await cell.innerText().catch(()=>'' )).replace(/\s+/g,' ').trim();
            if(/eco/i.test(text)&&/friendly/i.test(text)) matches.push(i);
        }
        if(matches.length!==1) return null;
        return cells.nth(matches[0]);
    }

    private async ensureEcoFriendly(): Promise<CampaignItemEvidence> {
        const active = this.activeEcoLocator();
        if (await this.verifyActive(active, 'campaign:eco:precheck')) {
            return { required: true, activeBefore: true, purchaseAttempted: false, verifiedActive: true,
                status: 'already_active', reason: 'ACTIVE_BEFORE_ACTION' };
        }

        const newCampaignButton = this.page.locator('button:visible').filter({ hasText: /New campaign/i }).first();
        if(await newCampaignButton.count()!==1){
            return { required:true,activeBefore:false,purchaseAttempted:false,verifiedActive:false,
                status:'unverified',reason:'NEW_CAMPAIGN_CONTROL_NOT_UNIQUE_VISIBLE' };
        }
        await this.moveAndClick(newCampaignButton);
        await GeneralUtils.randomSleep(700, 1200);

        // The AM4 label has varied between "Eco-friendly Increases",
        // "Eco friendly Increases" and shorter localized forms. Never guess:
        // first re-check whether the campaign became active, then require one
        // and only one visible Eco/friendly option before clicking it.
        if(await this.isVisible(active,700)){
            return { required:true,activeBefore:true,purchaseAttempted:false,verifiedActive:true,
                status:'already_active',reason:'ACTIVE_AFTER_NEW_CAMPAIGN_VIEW' };
        }
        const ecoFriendlyCell=await this.uniqueVisibleEcoOption();
        if(!ecoFriendlyCell){
            return { required:true,activeBefore:false,purchaseAttempted:false,verifiedActive:false,
                status:'unverified',reason:'ECO_OPTION_NOT_UNIQUE_VISIBLE' };
        }
        await this.moveAndClick(ecoFriendlyCell);
        await GeneralUtils.randomSleep(700, 1200);
        const buyButtons = this.page.locator('button:visible').filter({ hasText: /^\$/ });
        if (await buyButtons.count() !== 1) {
            return { required: true, activeBefore: false, purchaseAttempted: false, verifiedActive: false,
                status: 'unverified', reason: 'ECO_PURCHASE_CONTROL_NOT_UNIQUE_VISIBLE' };
        }
        const buyButton = buyButtons.first();

        try {
            await this.moveAndClick(buyButton);
        } catch (error) {
            if ((error as Error)?.message === 'INTERACTIVE_CHALLENGE_DETECTED_STOP') throw error;
            return { required: true, activeBefore: false, purchaseAttempted: true, verifiedActive: false,
                status: 'unverified', reason: 'ECO_PURCHASE_OUTCOME_UNCONFIRMED:' + ((error as Error)?.message || 'UNCLASSIFIED') };
        }

        await GeneralUtils.randomSleep(700, 1200);
        const verified = await this.verifyActive(active, 'campaign:eco:post-purchase');
        return { required: true, activeBefore: false, purchaseAttempted: true, verifiedActive: verified,
            status: verified ? 'purchased_verified' : 'unverified',
            reason: verified ? 'POST_PURCHASE_ACTIVE_CONFIRMED' : 'POST_PURCHASE_ACTIVE_NOT_CONFIRMED' };
    }

    private async ensureReputation(): Promise<CampaignItemEvidence> {
        if (!this.increaseAirlineReputation) {
            return { required: false, activeBefore: false, purchaseAttempted: false, verifiedActive: false,
                status: 'not_required', reason: 'REPUTATION_NOT_REQUIRED' };
        }

        const active = this.activeReputationLocator();
        if (await this.verifyActive(active, 'campaign:reputation:precheck')) {
            return { required: true, activeBefore: true, purchaseAttempted: false, verifiedActive: true,
                status: 'already_active', reason: 'ACTIVE_BEFORE_ACTION' };
        }

        const newCampaignButton = this.page.getByRole('button', { name: /New campaign/i }).first();
        await this.moveAndClick(newCampaignButton);
        await GeneralUtils.randomSleep(600, 1000);
        const increaseReputationCell = this.page.locator('td:visible').filter({ hasText: /Increase\s+airline\s+reputation/i }).first();
        await this.moveAndClick(increaseReputationCell);
        await GeneralUtils.randomSleep(600, 1000);

        const durationOption = (Math.floor(this.campaignDuration / 4) || 1).toString();
        const durationSelect = this.page.locator('#dSelector:visible');
        await this.moveAndSelectOption(durationSelect, durationOption);
        await GeneralUtils.randomSleep(500, 800);

        const targetCampaignButton = this.page
            .locator('tr:visible:has(td:has-text("Campaign ' + this.campaignType + '")) .btn-danger:visible')
            .first();
        try {
            await this.moveAndClick(targetCampaignButton);
        } catch (error) {
            if ((error as Error)?.message === 'INTERACTIVE_CHALLENGE_DETECTED_STOP') throw error;
            return { required: true, activeBefore: false, purchaseAttempted: true, verifiedActive: false,
                status: 'unverified', reason: 'REPUTATION_PURCHASE_OUTCOME_UNCONFIRMED:' + ((error as Error)?.message || 'UNCLASSIFIED') };
        }

        await GeneralUtils.randomSleep(700, 1200);
        const verified = await this.verifyActive(active, 'campaign:reputation:post-purchase');
        return { required: true, activeBefore: false, purchaseAttempted: true, verifiedActive: verified,
            status: verified ? 'purchased_verified' : 'unverified',
            reason: verified ? 'POST_PURCHASE_ACTIVE_CONFIRMED' : 'POST_PURCHASE_ACTIVE_NOT_CONFIRMED' };
    }

    /**
     * One-shot recovery after an obscured Marketing control. This method is
     * intentionally read-only: it never opens a purchase flow or assumes a
     * campaign is active from a previous run. The caller must have reopened
     * the Marketing panel through a challenge-guarded normal click.
     */
    public async verifyRequiredCampaignsReadOnly(): Promise<CampaignEvidence> {
        await assertNoInteractiveChallenge(this.page, 'campaign:readonly-recovery');
        const ecoMatches = this.page.locator('td:visible')
            .filter({ hasText: /^[^A-Za-z0-9]*Eco[\\s-]+friendly\\s*$/i });
        const reputationMatches = this.page.locator('td:visible')
            .filter({ hasText: /^[^A-Za-z0-9]*Airline\\s+reputation\\s*$/i });
        const ecoVerified = await ecoMatches.count() === 1;
        const reputationVerified = this.increaseAirlineReputation
            ? await reputationMatches.count() === 1
            : false;
        const ecoFriendly: CampaignItemEvidence = {
            required: true, activeBefore: ecoVerified, purchaseAttempted: false,
            verifiedActive: ecoVerified, status: ecoVerified ? 'already_active' : 'unverified',
            reason: ecoVerified ? 'READONLY_ACTIVE_UNIQUE' : 'READONLY_ACTIVE_NOT_UNIQUE_OR_MISSING'
        };
        const airlineReputation: CampaignItemEvidence = this.increaseAirlineReputation
            ? {
                required: true, activeBefore: reputationVerified, purchaseAttempted: false,
                verifiedActive: reputationVerified,
                status: reputationVerified ? 'already_active' : 'unverified',
                reason: reputationVerified ? 'READONLY_ACTIVE_UNIQUE' : 'READONLY_ACTIVE_NOT_UNIQUE_OR_MISSING'
            }
            : {
                required: false, activeBefore: false, purchaseAttempted: false,
                verifiedActive: false, status: 'not_required', reason: 'REPUTATION_NOT_REQUIRED'
            };
        const allRequiredVerified = ecoVerified &&
            (!airlineReputation.required || reputationVerified);
        return {
            schemaVersion: 1, observedAt: new Date().toISOString(),
            ecoFriendly, airlineReputation,
            allRequiredVerified, departureAuthorized: allRequiredVerified
        };
    }

    public async createCampaign(): Promise<CampaignEvidence> {
        console.log('Iniciando verificacao de campanhas...');
        await assertNoInteractiveChallenge(this.page, 'campaign:start');
        const marketingButton = this.page.getByRole('button', { name: /Marketing/i }).first();
        const campaignContentVisible =
            await this.isVisible(this.activeEcoLocator(), 400) ||
            await this.isVisible(this.activeReputationLocator(), 400) ||
            await this.isVisible(this.page.getByRole('button', { name: /New campaign/i }).first(), 400);
        if (!campaignContentVisible) {
            await this.moveAndClick(marketingButton);
            await GeneralUtils.randomSleep(700, 1200);
        } else {
            console.log('[Campaign] Painel de Marketing ja aberto; clique redundante ignorado.');
        }

        const ecoFriendly = await this.ensureEcoFriendly();
        await GeneralUtils.randomSleep(500, 800);
        const airlineReputation = !ecoFriendly.verifiedActive && this.increaseAirlineReputation
            ? {
                required: true, activeBefore: false, purchaseAttempted: false, verifiedActive: false,
                status: 'unverified' as const, reason: 'PREVIOUS_REQUIRED_CAMPAIGN_UNVERIFIED'
              }
            : await this.ensureReputation();
        const allRequiredVerified = ecoFriendly.verifiedActive &&
            (!airlineReputation.required || airlineReputation.verifiedActive);

        const evidence: CampaignEvidence = {
            schemaVersion: 1,
            observedAt: new Date().toISOString(),
            ecoFriendly,
            airlineReputation,
            allRequiredVerified,
            departureAuthorized: allRequiredVerified
        };

        console.log('[Campaign] ' + JSON.stringify({
            eco: ecoFriendly.status,
            reputation: airlineReputation.status,
            allRequiredVerified
        }));
        return evidence;
    }
}
