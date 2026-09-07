import { Worker } from 'bullmq';
import { bullConnection } from './lib/redis.js';
import { processDebounce, processSend, processFollowup, processReactivate, logEvent, markActivationFailed } from './services/pipeline.js';
import { procesarCobro, barrerPendientes, mdActivo } from './services/marketplace.js';

// Cada cuánto se repasan los cobros que quedaron colgados (proceso muerto entre el INSERT y el job,
// o reintentos agotados). Es la red de seguridad del outbox, no la vía normal.
const BARRIDO_MS = 5 * 60_000;

export function startWorkers() {
  const opts = (concurrency) => ({ connection: bullConnection(), concurrency });

  const debounceWorker = new Worker('debounce', processDebounce, opts(5));
  const sendWorker = new Worker('send', processSend, opts(10));
  const followupWorker = new Worker('followup', processFollowup, opts(5));
  const reactivateWorker = new Worker('reactivate', processReactivate, opts(5));
  // concurrencia baja: son llamadas a un tercero con rate limit (600/min por clave)
  const chargeWorker = new Worker('charge', procesarCobro, opts(3));

  if (mdActivo()) {
    const barrido = setInterval(() => { barrerPendientes().catch(() => {}); }, BARRIDO_MS);
    barrido.unref?.(); // no debe impedir que el proceso termine
  }

  for (const w of [debounceWorker, sendWorker, followupWorker, reactivateWorker, chargeWorker]) {
    w.on('failed', (job, err) => {
      console.error(`[worker:${w.name}] job ${job?.id} falló:`, err.message);
      logEvent('error_worker', { queue: w.name, job: job?.id, data: job?.data, error: err.message }).catch(() => {});
      // Si falla un job de debounce con una activación en curso, no dejar su registro 'esperando' colgado.
      if (w.name === 'debounce' && job?.data?.conversationId) {
        markActivationFailed(job.data.conversationId).catch(() => {});
      }
    });
  }
  console.log(`[workers] debounce, send, followup, reactivate${mdActivo() ? ' y charge (marketplace)' : ''} en marcha`);
  return { debounceWorker, sendWorker, followupWorker, reactivateWorker, chargeWorker };
}
