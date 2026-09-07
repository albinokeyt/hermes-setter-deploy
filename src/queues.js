import { Queue } from 'bullmq';
import { bullConnection } from './lib/redis.js';

const connection = bullConnection();

const defaultOpts = { removeOnComplete: 500, removeOnFail: 200 };

export const debounceQueue = new Queue('debounce', { connection, defaultJobOptions: defaultOpts });
export const sendQueue = new Queue('send', { connection, defaultJobOptions: { ...defaultOpts, attempts: 2, backoff: { type: 'exponential', delay: 4000 } } });
export const followupQueue = new Queue('followup', { connection, defaultJobOptions: defaultOpts });
export const reactivateQueue = new Queue('reactivate', { connection, defaultJobOptions: defaultOpts });
// 💳 Cobros al Marketplace Disruptivo. attempts:1 a propósito: los reintentos los gobierna la
// política del contrato dentro de cobrar() (mismo event_id, backoff 2s/4s/6s…), y lo que BullMQ
// reintentara por su cuenta se saldría de esa política. Lo que quede colgado lo recoge el barrido.
export const chargeQueue = new Queue('charge', { connection, defaultJobOptions: { ...defaultOpts, attempts: 1 } });
