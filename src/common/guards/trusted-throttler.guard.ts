import { Injectable } from '@nestjs/common';
import { ThrottlerGuard } from '@nestjs/throttler';
import type { Request } from 'express';
import { rateLimitIp } from '../trusted-ip.js';

/** The auth throttler, keyed by the trusted client IP (see rateLimitIp). */
@Injectable()
export class TrustedThrottlerGuard extends ThrottlerGuard {
  protected override async getTracker(req: Record<string, unknown>): Promise<string> {
    const secret = process.env.TRUSTED_PROXY_SECRET?.trim();
    return rateLimitIp(req as unknown as Request, secret && secret.length >= 16 ? secret : undefined);
  }
}
