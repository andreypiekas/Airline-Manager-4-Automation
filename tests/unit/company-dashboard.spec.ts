import { test, expect } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { join, resolve } from 'node:path';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { serializeJsonDocument } from '../../utils/json-document';

test('dashboard self-test surfaces aircraft deferred by run time budget',()=>{
  const output=execFileSync(process.execPath,[resolve('scripts/company-dashboard.cjs'),'--self-test'],{
    cwd:process.cwd(),encoding:'utf8',timeout:15_000
  });
  expect(output).toContain('company-dashboard self-test ok');
});

// Regression for production #1200: a literal backslash-n after the fallback
// JSON made the dashboard silently show zero aircraft although 169/170 were seen.
test('partial rolling fallback remains parseable and visible in dashboard (#1200)',()=>{
  const dir=mkdtempSync(join(tmpdir(),'am4-fleet-fallback-'));
  try{
    const fallback={schemaVersion:1,mode:'native-individual-fallback',globalComplete:false,
      observed:169,expected:170,globalMutationsAuthorized:false,individualTargetChecksRequired:true,
      generatedAt:'2026-10-30T01:08:34.034Z'};
    const serialized=serializeJsonDocument(fallback);
    expect(serialized.endsWith('\\n')).toBe(false);
    expect(serialized.endsWith('\n')).toBe(true);
    expect(JSON.parse(serialized)).toEqual(fallback);
    writeFileSync(join(dir,'global-fleet-fallback.json'),serialized);
    writeFileSync(join(dir,'execution-report.json'),JSON.stringify({dryRun:false,
      summary:{evaluated:18,departed:4,held:14,unknown:0},entries:[]}));
    execFileSync(process.execPath,[resolve('scripts/company-dashboard.cjs'),dir],{
      cwd:process.cwd(),encoding:'utf8',timeout:15_000
    });
    const dashboard=JSON.parse(readFileSync(join(dir,'company-dashboard.json'),'utf8'));
    expect(dashboard.fleet.seen).toBe(169);
    expect(dashboard.fleet.expected).toBe(170);
    expect(dashboard.fleet.collectionComplete).toBe(false);
    expect(dashboard.departures.departed).toBe(4);
  }finally{rmSync(dir,{recursive:true,force:true});}
});

test('first-page-only dashboard labels sampled targets without claiming full fleet',()=>{
  const dir=mkdtempSync(join(tmpdir(),'am4-page-only-'));
  try{
    writeFileSync(join(dir,'first-page-only-report.json'),serializeJsonDocument({
      schemaVersion:1,mode:'current-first-page-only',globalComplete:false,
      scope:'VERIFIED_WINDOWS_ONLY',evaluated:19,departed:5,held:14,unknown:0,
      fleetWideCompletionClaim:false,globalFleetScans:0
    }));
    writeFileSync(join(dir,'execution-report.json'),JSON.stringify({dryRun:false,
      summary:{evaluated:19,departed:5,held:14,unknown:0},entries:[]}));
    execFileSync(process.execPath,[resolve('scripts/company-dashboard.cjs'),dir],{
      cwd:process.cwd(),encoding:'utf8',timeout:15_000
    });
    const dashboard=JSON.parse(readFileSync(join(dir,'company-dashboard.json'),'utf8'));
    const markdown=readFileSync(join(dir,'company-dashboard.md'),'utf8');
    expect(dashboard.fleet.scope).toBe('FIRST_PAGE_ONLY');
    expect(dashboard.fleet.seen).toBe(19);
    expect(dashboard.fleet.expected).toBeNull();
    expect(dashboard.fleet.collectionComplete).toBe(false);
    expect(dashboard.departures.departed).toBe(5);
    expect(markdown).toContain('Página atual (sem inventário global)');
    expect(markdown).toContain('frota global NÃO examinada');
  }finally{rmSync(dir,{recursive:true,force:true});}
});
