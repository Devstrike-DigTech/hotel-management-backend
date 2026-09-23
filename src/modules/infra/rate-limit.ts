import {
  CanActivate,
  ExecutionContext,
  HttpStatus,
  Injectable,
  Logger,
  SetMetadata,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Response } from 'express';
import type { AppRequest } from '../../common/auth-types.js';
import { AppException, ErrorCode } from '../../common/errors/app-exception.js';
import { AppConfigService } from '../../config/app-config.service.js';
import { RedisService } from './redis.service.js';

export interface RateRule {
  /** Bucket name, e.g. "quote". */
  name: string;
  limit: number;
  windowSec: number;
}

export const RATE_LIMIT_KEY = 'rate:limits';

/** Per-IP fixed-window limit(s) for a public route (see RateLimitGuard). */
export const RateLimit = (...rules: RateRule[]) => SetMetadata(RATE_LIMIT_KEY, rules);

export function rateLimited(retryAfterSec: number, scope: 'ip' | 'phone' | 'email', message?: string) {
  return new AppException(
    HttpStatus.TOO_MANY_REQUESTS,
    ErrorCode.RATE_LIMITED,
    message ?? 'Too many requests. Please wait a moment and try again.',
    { retryAfterSec, scope },
  );
}

/**
 * Redis fixed-window counters (INCR + EXPIRE on first hit). Shared by all API
 * instances. If Redis is unreachable the request is allowed (fail open) and a
 * warning is logged: availability of booking beats strict limiting.
 */
@Injectable()
export class RateLimitService {
  private readonly logger = new Logger(RateLimitService.name);

  constructor(
    private readonly redis: RedisService,
    private readonly config: AppConfigService,
  ) {}

  get enabled(): boolean {
    return this.config.get('PUBLIC_RATE_LIMITS');
  }

  /** Counts a hit; returns seconds to wait when over the limit, else 0. */
  async hit(key: string, limit: number, windowSec: number): Promise<number> {
    if (!this.enabled) return 0;
    const k = `rl:${key}`;
    try {
      const n = await this.redis.client.incr(k);
      if (n === 1) await this.redis.client.expire(k, windowSec);
      if (n > limit) {
        const ttl = await this.redis.client.ttl(k);
        return ttl > 0 ? ttl : windowSec;
      }
      return 0;
    } catch (e) {
      this.logger.warn(`Rate limit check skipped (${(e as Error).message})`);
      return 0;
    }
  }

  /** Throws 429 RATE_LIMITED when the bucket is full. */
  async consume(key: string, limit: number, windowSec: number, scope: 'ip' | 'phone' | 'email', message?: string, res?: Response) {
    const wait = await this.hit(key, limit, windowSec);
    if (wait > 0) {
      res?.setHeader('Retry-After', String(wait));
      throw rateLimited(wait, scope, message);
    }
  }
}

@Injectable()
export class RateLimitGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly limits: RateLimitService,
  ) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const rules = this.reflector.getAllAndOverride<RateRule[] | undefined>(RATE_LIMIT_KEY, [ctx.getHandler(), ctx.getClass()]);
    if (!rules?.length) return true;
    const req = ctx.switchToHttp().getRequest<AppRequest>();
    const res = ctx.switchToHttp().getResponse<Response>();
    const ip = req.ip ?? 'unknown';
    for (const r of rules) {
      await this.limits.consume(`${r.name}:ip:${ip}`, r.limit, r.windowSec, 'ip', undefined, res);
    }
    return true;
  }
}
