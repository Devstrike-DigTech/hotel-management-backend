import { Injectable, Logger } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { AppConfigService } from '../../config/app-config.service.js';
import { RedisService } from '../infra/redis.service.js';

export interface OutboxMessage {
  id: string;
  createdAt: string;
  channel: string;
  template: string;
  to: string;
  subject: string | null;
  text: string;
  html: string | null;
  meta: Record<string, unknown>;
}

const KEEP = 50;

/**
 * Development mailbox: the last 50 messages that would have been sent, kept
 * in Redis (not the database, so OTP codes never land in a table). Never used
 * in production.
 */
@Injectable()
export class DevOutboxService {
  private readonly logger = new Logger(DevOutboxService.name);
  private readonly key: string;

  constructor(
    private readonly redis: RedisService,
    private readonly config: AppConfigService,
  ) {
    this.key = `devoutbox:${config.get('NODE_ENV')}`;
  }

  get available(): boolean {
    return !this.config.isProduction;
  }

  async push(m: Omit<OutboxMessage, 'id' | 'createdAt'>): Promise<string> {
    const msg: OutboxMessage = { id: randomUUID(), createdAt: new Date().toISOString(), ...m };
    try {
      await this.redis.client.multi().lpush(this.key, JSON.stringify(msg)).ltrim(this.key, 0, KEEP - 1).expire(this.key, 7 * 86_400).exec();
    } catch (e) {
      this.logger.warn(`Dev outbox write failed: ${(e as Error).message}`);
    }
    return msg.id;
  }

  async list(limit = KEEP, to?: string): Promise<OutboxMessage[]> {
    const raw = await this.redis.client.lrange(this.key, 0, KEEP - 1);
    const items = raw.map((r) => JSON.parse(r) as OutboxMessage);
    const filtered = to ? items.filter((m) => m.to.toLowerCase().includes(to.toLowerCase().replace(/\s/g, ''))) : items;
    return filtered.slice(0, Math.max(1, Math.min(KEEP, limit)));
  }

  async clear(): Promise<void> {
    await this.redis.client.del(this.key);
  }
}
