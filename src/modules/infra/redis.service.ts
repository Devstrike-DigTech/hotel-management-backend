import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { Redis } from 'ioredis';
import { AppConfigService } from '../../config/app-config.service.js';
import { redisConnection } from '../jobs/jobs.constants.js';

/**
 * Shared Redis client for request-path features (rate limits, dev outbox,
 * small caches). BullMQ keeps its own connections.
 */
@Injectable()
export class RedisService implements OnModuleDestroy {
  private readonly logger = new Logger(RedisService.name);
  readonly client: Redis;

  constructor(config: AppConfigService) {
    this.client = new Redis({
      ...redisConnection(config.get('REDIS_URL')),
      maxRetriesPerRequest: 2,
      lazyConnect: false,
      enableOfflineQueue: true,
    });
    this.client.on('error', (e) => this.logger.warn(`Redis: ${e.message}`));
  }

  async onModuleDestroy(): Promise<void> {
    await this.client.quit().catch(() => undefined);
  }

  async getJson<T>(key: string): Promise<T | null> {
    const raw = await this.client.get(key);
    if (!raw) return null;
    try {
      return JSON.parse(raw) as T;
    } catch {
      return null;
    }
  }

  async setJson(key: string, value: unknown, ttlSec: number): Promise<void> {
    await this.client.set(key, JSON.stringify(value), 'EX', ttlSec);
  }
}
