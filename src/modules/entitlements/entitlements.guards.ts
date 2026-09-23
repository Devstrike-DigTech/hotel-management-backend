import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { AppRequest } from '../../common/auth-types.js';
import { ALLOW_READ_ONLY_KEY } from '../../common/decorators/index.js';
import type { LimitCode } from './entitlements.constants.js';
import {
  CHECK_LIMIT_KEY,
  REQUIRE_FEATURE_KEY,
} from './entitlements.decorators.js';
import {
  EntitlementsService,
  type TenantEntitlements,
} from './entitlements.service.js';

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/** Loads entitlements once per request and memoises them on the request. */
export async function entitlementsFor(
  req: AppRequest,
  service: EntitlementsService,
): Promise<TenantEntitlements> {
  req.entitlementsCache ??= new Map();
  const cached = req.entitlementsCache.get('ent') as
    | TenantEntitlements
    | undefined;
  if (cached) return cached;
  const ent = await service.getEntitlements(req.user!.tenantId);
  req.entitlementsCache.set('ent', ent);
  return ent;
}

/**
 * Blocks mutating hotel requests (anything but GET/HEAD/OPTIONS) when the
 * subscription is READ_ONLY / SUSPENDED, with 402 SUBSCRIPTION_READ_ONLY.
 * Opt out per route with `@AllowWhenReadOnly()`.
 */
@Injectable()
export class SubscriptionGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly entitlements: EntitlementsService,
  ) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const req = ctx.switchToHttp().getRequest<AppRequest>();
    if (!req.user || SAFE_METHODS.has(req.method.toUpperCase())) return true;
    const allowed = this.reflector.getAllAndOverride<boolean>(
      ALLOW_READ_ONLY_KEY,
      [ctx.getHandler(), ctx.getClass()],
    );
    if (allowed) return true;
    const ent = await entitlementsFor(req, this.entitlements);
    this.entitlements.assertWritable(ent);
    return true;
  }
}

/** Enforces `@RequireFeature(...)`. */
@Injectable()
export class FeatureGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly entitlements: EntitlementsService,
  ) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const features = this.reflector.getAllAndOverride<string[] | undefined>(
      REQUIRE_FEATURE_KEY,
      [ctx.getHandler(), ctx.getClass()],
    );
    if (!features?.length) return true;
    const req = ctx.switchToHttp().getRequest<AppRequest>();
    if (!req.user) return true;
    const ent = await entitlementsFor(req, this.entitlements);
    for (const f of features) {
      await this.entitlements.assertFeature(ent, f);
    }
    return true;
  }
}

/** Enforces `@CheckLimit(...)`. */
@Injectable()
export class LimitGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly entitlements: EntitlementsService,
  ) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const limit = this.reflector.getAllAndOverride<LimitCode | undefined>(
      CHECK_LIMIT_KEY,
      [ctx.getHandler(), ctx.getClass()],
    );
    if (!limit) return true;
    const req = ctx.switchToHttp().getRequest<AppRequest>();
    if (!req.user) return true;
    const ent = await entitlementsFor(req, this.entitlements);
    await this.entitlements.assertWithinLimit(ent, limit, 1);
    return true;
  }
}
