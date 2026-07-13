import { Queue } from 'bullmq';
import { bullConnection } from './lib/redis.js';

const connection = bullConnection();

const defaultOpts = { removeOnComplete: 500, removeOnFail: 200 };

export const debounceQueue = new Queue('debounce', { connection, defaultJobOptions: defaultOpts });
export const sendQueue = new Queue('send', { connection, defaultJobOptions: { ...defaultOpts, attempts: 2, backoff: { type: 'exponential', delay: 4000 } } });
export const followupQueue = new Queue('followup', { connection, defaultJobOptions: defaultOpts });
