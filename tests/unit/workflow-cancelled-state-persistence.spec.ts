import { test, expect } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

test('run #1081: cancelled live bot still persists verified checkpoints after successful restore', async () => {
  // #1081 confirmed 19 departures, then job cancellation skipped the old
  // success/failure-only state save. This test validates the workflow gate;
  // it never opens the game or performs any real mutation.
  const workflow = await readFile(join(process.cwd(), '.github/workflows/playwright.yml'), 'utf8');
  const step = workflow.match(/    - name: Persistir registro de retornos\n([\s\S]*?)(?=\n    - name: |$)/);
  expect(step, 'persistent-state step must exist').not.toBeNull();
  const condition = step![1].match(/^\s+if: (.+)$/m)?.[1];
  expect(condition).toBeDefined();
  expect(condition).toContain('always()');
  expect(condition).toContain("inputs.departure_mode != 'simulation'");
  expect(condition).toContain("steps.state_restore.outcome == 'success'");
  for (const outcome of ['success', 'failure', 'cancelled']) {
    expect(condition).toContain(`steps.bot.outcome == '${outcome}'`);
  }
  expect(step![1]).toContain('node .am4-tools/optimization/github-state.js save');
  expect(step![1]).not.toContain('continue-on-error: true');
});

test('cancel recovery does not change live execution and concurrency safeguards', async () => {
  const workflow = await readFile(join(process.cwd(), '.github/workflows/playwright.yml'), 'utf8');
  expect(workflow).toContain('cancel-in-progress: false');
  expect(workflow).toContain('timeout-minutes: 29');
  expect(workflow).toContain('DEMAND_FAIL_SAFE:');
  expect(workflow).toContain("DEMAND_EXECUTION_ACK: individual-return-legs-v1");
  expect(workflow).toContain('Verificar SHA atual antes de acessar o jogo');
  expect(workflow).toContain("if: steps.current_head.outputs.stale != 'true'");
});
