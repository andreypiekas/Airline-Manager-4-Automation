import { test, expect } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';

test('dashboard self-test surfaces aircraft deferred by run time budget',()=>{
  const output=execFileSync(process.execPath,[resolve('scripts/company-dashboard.cjs'),'--self-test'],{
    cwd:process.cwd(),encoding:'utf8',timeout:15_000
  });
  expect(output).toContain('company-dashboard self-test ok');
});
