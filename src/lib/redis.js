import { Redis } from 'ioredis';
import { config } from '../config.js';

export const redis = new Redis(config.redisUrl, { maxRetriesPerRequest: 2 });

export function bullConnection() {
  return new Redis(config.redisUrl, { maxRetriesPerRequest: null });
}
