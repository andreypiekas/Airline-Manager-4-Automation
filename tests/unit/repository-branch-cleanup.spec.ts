import { test, expect } from '@playwright/test';
import { execFileSync } from 'node:child_process';

test('branch cleanup is offline, preserves runtime/main, and never needs a token in self-test',()=>{
  const output=execFileSync(process.execPath,
    ['scripts/prune-merged-branches.cjs','--self-test'],{
      encoding:'utf8',timeout:10000,
      env:{...process.env,GITHUB_TOKEN:'',GH_TOKEN:'',GITHUB_REPOSITORY:''}
    });
  expect(output).toContain('self-test passed');
});
