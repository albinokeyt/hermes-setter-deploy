import { Worker } from 'bullmq';
import { bullConnection } from './lib/redis.js';
import { processDebounce, processSend, processFollowup, processReactivate, logEvent } from './services/pipeline.js';

export function startWorkers() {
  const opts = (concurrency) => ({ connection: bullConnection(), concurrency });

  const debounceWorker = new Worker('debounce', processDebounce, opts(5));
  const sendWorker = new Worker('send', processSend, opts(10));
  const followupWorker = new Worker('followup', processFollowup, opts(5));
  const reactivateWorker = new Worker('reactivate', processReactivate, opts(5));

  for (const w of [debounceWorker, sendWorker, followupWorker, reactivateWorker]) {
    w.on('failed', (job, err) => {
      console.error(`[worker:${w.name}] job ${job?.id} falló:`, err.message);
      logEvent('error_worker', { queue: w.name, job: job?.id, data: job?.data, error: err.message }).catch(() => {});
    });
  }
  console.log('[workers] debounce, send, followup y reactivate en marcha');
  return { debounceWorker, sendWorker, followupWorker, reactivateWorker };
}
