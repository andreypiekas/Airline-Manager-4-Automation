import { test, expect } from '@playwright/test';
import { execFileSync } from 'node:child_process';

test('reviewed stale branch cleanup never requires credentials for its safety checks',()=>{
  const output=execFileSync(process.execPath,
    ['scripts/retire-audited-branches.cjs','--self-test'],{
      encoding:'utf8',timeout:10000,
      env:{...process.env,GITHUB_TOKEN:'',GH_TOKEN:'',GITHUB_REPOSITORY:''}
    });
  expect(output).toContain('[AuditedBranchCleanup] self-test passed');
});

test('audited branch cleanup fails closed without token and does not mutate by default',()=>{
  let error:unknown;
  try {
    execFileSync(process.execPath,['scripts/retire-audited-branches.cjs'],{
      encoding:'utf8',timeout:10000,stdio:'pipe',
      env:{...process.env,GITHUB_TOKEN:'',GH_TOKEN:'',GITHUB_REPOSITORY:''}
    });
  }catch(e){error=e;}
  expect(error).toBeDefined();
  expect((error as {status?:number}).status).not.toBe(0);
});
