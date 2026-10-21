import {defineConfig} from '@playwright/test';
export default defineConfig({
 testDir:'./tests/live',testMatch:'manual-rename.spec.ts',
 fullyParallel:false,workers:1,retries:0,timeout:1500000,
 forbidOnly:!!process.env.CI,reporter:'list',outputDir:'test-results/rename-run',
 use:{trace:'off',screenshot:'off',video:'off',actionTimeout:25000,navigationTimeout:30000}
});
