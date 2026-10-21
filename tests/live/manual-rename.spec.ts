import {test} from '@playwright/test';
import {withRunLock} from '../../utils/run-lock';
import {runManualFleetRename} from '../../fleet-rename/run';

// Standalone manual entrypoint: no imports of purchase, campaign, departure,
// reroute or pricing modules. No cron/retries. Action-specific approval in run.ts.
test('previsualizar ou aplicar renomeação manual com verificação nativa',async({page})=>{
 await withRunLock(async()=>{
  await runManualFleetRename(page,process.env,'test-results/fleet-rename');
 });
});
