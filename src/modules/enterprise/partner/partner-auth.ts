import {
  CallHandler,
  CanActivate,
  ExecutionContext,
  HttpStatus,
  Injectable,
  Logger,
  NestInterceptor,
  SetMetadata,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Response } from 'express';
import { catchError, from, map, Observable, of, throwError } from 'rxjs';
import type { AppRequest, AuthUser } from '../../../common/auth-types.js';
import { AppException, ErrorCode } from '../../../common/errors/app-exception.js';
import { apiKeyContext } from '../../../common/impersonation-context.js';
import { propertyScopeStore } from '../../../common/property-scope.js';
import { AppConfigService } from '../../../config/app-config.service.js';
import { DbService, DryRunRollback, dryRunContext } from '../../../prisma/db.service.js';
import { EntitlementsService } from '../../entitlements/entitlements.service.js';
import { RedisService } from '../../infra/redis.service.js';
import { ipAllowed, normaliseIp } from '../../platform/security/cidr.js';
import { permissionsForScopes, rateLimitsFor, type ApiScope } from '../api-keys/api-keys.logic.js';
import { ApiKeysService } from '../api-keys/api-keys.service.js';

export const PARTNER_SCOPE_KEY = 'partner:scope';
/** Scope a partner route needs (none = any valid key). */
export const PartnerScope = (scope: ApiScope) => SetMetadata(PARTNER_SCOPE_KEY, scope);

const SAFE = new Set(['GET', 'HEAD', 'OPTIONS']);

/** What the guard attaches to the request for the handlers. */
export interface PartnerContext {
  keyId: string;
  name: string;
  environment: 'LIVE' | 'TEST';
  tenantId: string;
  tenantName: string;
  scopes: string[];
  /** Properties the key may see (its restriction, else all of the tenant's). */
  propertyIds: string[];
  restricted: boolean;
}

export type PartnerRequest = AppRequest & { partner?: PartnerContext };

export function partnerError(status: number, code: string, message: string, details?: Record<string, unknown>) {
  return new AppException(status, code, message, details);
}

/**
 * Partner API authentication (M6): API key (Bearer or X-Api-Key), IP
 * allowlist, tenant feature `api_access`, scope, rate limits with
 * RateLimit-* headers, required Idempotency-Key on writes and usage
 * metering. It sets `req.user` to a synthetic staff principal (the key's
 * creator, with the permissions the scopes grant) so writes reuse the hotel
 * services, their validation and their audit trail.
 */
@Injectable()
export class PartnerGuard implements CanActivate {
  private readonly logger = new Logger(PartnerGuard.name);

  constructor(
    private readonly reflector: Reflector,
    private readonly keys: ApiKeysService,
    private readonly db: DbService,
    private readonly entitlements: EntitlementsService,
    private readonly redis: RedisService,
    private readonly config: AppConfigService,
  ) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const req = ctx.switchToHttp().getRequest<PartnerRequest>();
    const res = ctx.switchToHttp().getResponse<Response>();
    const auth = req.headers.authorization;
    const raw = auth?.toLowerCase().startsWith('bearer ') ? auth.slice(7).trim() : (req.headers['x-api-key'] as string | undefined);
    const key = await this.keys.authenticate(raw);
    if (!key) throw partnerError(HttpStatus.UNAUTHORIZED, 'INVALID_API_KEY', 'The API key is missing, unknown, revoked or expired');

    const write = !SAFE.has(req.method.toUpperCase());
    const ip = normaliseIp(req.ip);
    let limited = false;
    // Metering: one row per request, whatever the outcome.
    res.on('finish', () => {
      this.keys.meter(key, { error: res.statusCode >= 400, write, rateLimited: limited, ip });
    });

    if (key.ipAllowlist.length && !ipAllowed(ip, key.ipAllowlist)) {
      throw partnerError(HttpStatus.FORBIDDEN, 'IP_NOT_ALLOWED', 'This API key may not be used from this address', { ip });
    }

    const ent = await this.entitlements.getEntitlements(key.tenantId);
    if (!ent.features.includes('api_access')) {
      throw new AppException(HttpStatus.FORBIDDEN, ErrorCode.FEATURE_LOCKED, 'This hotel plan does not include API access', { feature: 'api_access', requiredPlan: 'enterprise' });
    }

    // Rate limits (per key): per-minute window and a per-second burst.
    const { perMinute, perSecond } = rateLimitsFor(
      ent.subscription.planCode,
      this.config.get('PARTNER_RATE_LIMIT_ENTERPRISE'),
      this.config.get('PARTNER_RATE_LIMIT_DEFAULT'),
    );
    const nowSec = Math.floor(Date.now() / 1000);
    const minute = Math.floor(nowSec / 60);
    const reset = 60 - (nowSec % 60);
    let used = 0;
    let burst = 0;
    try {
      const m = this.redis.client.multi();
      m.incr(`prl:${key.id}:m:${minute}`);
      m.expire(`prl:${key.id}:m:${minute}`, 70);
      m.incr(`prl:${key.id}:s:${nowSec}`);
      m.expire(`prl:${key.id}:s:${nowSec}`, 3);
      const out = await m.exec();
      used = Number(out?.[0]?.[1] ?? 0);
      burst = Number(out?.[2]?.[1] ?? 0);
    } catch (e) {
      this.logger.warn(`Partner rate limit skipped: ${(e as Error).message}`);
    }
    res.setHeader('RateLimit-Limit', String(perMinute));
    res.setHeader('RateLimit-Remaining', String(Math.max(0, perMinute - used)));
    res.setHeader('RateLimit-Reset', String(reset));
    res.setHeader('RateLimit-Policy', `${perMinute};w=60, ${perSecond};w=1`);
    if (used > perMinute || burst > perSecond) {
      limited = true;
      const retry = used > perMinute ? reset : 1;
      res.setHeader('Retry-After', String(retry));
      throw new AppException(HttpStatus.TOO_MANY_REQUESTS, ErrorCode.RATE_LIMITED, 'Rate limit exceeded for this API key', { retryAfterSec: retry });
    }

    const needed = this.reflector.getAllAndOverride<ApiScope | undefined>(PARTNER_SCOPE_KEY, [ctx.getHandler(), ctx.getClass()]);
    if (needed && !key.scopes.includes(needed)) {
      throw partnerError(HttpStatus.FORBIDDEN, 'INSUFFICIENT_SCOPE', `This API key lacks the ${needed} scope`, { required: needed });
    }
    if (write) {
      if (ent.writeBlocked) {
        throw new AppException(HttpStatus.PAYMENT_REQUIRED, ErrorCode.SUBSCRIPTION_READ_ONLY, 'The hotel subscription is read-only');
      }
      if (!req.headers['idempotency-key']) {
        throw partnerError(HttpStatus.BAD_REQUEST, 'IDEMPOTENCY_KEY_REQUIRED', 'Writes need an Idempotency-Key header (8-128 characters)');
      }
    }

    const { tenantName, propertyIds, creator } = await this.db.tenant(key.tenantId, (tx) =>
      this.db.withAllProperties(key.tenantId, async () => {
        const t = await tx.tenant.findUnique({ where: { id: key.tenantId }, select: { name: true } });
        const props = await tx.property.findMany({ where: { tenantId: key.tenantId }, select: { id: true }, orderBy: { createdAt: 'asc' } });
        const creator = key.createdById ? await tx.user.findUnique({ where: { id: key.createdById }, select: { id: true, email: true, fullName: true, isActive: true } }) : null;
        const owner = creator?.isActive ? creator : await tx.user.findFirst({ where: { tenantId: key.tenantId, role: 'OWNER', isActive: true }, select: { id: true, email: true, fullName: true, isActive: true }, orderBy: { createdAt: 'asc' } });
        return { tenantName: t?.name ?? '', propertyIds: props.map((p) => p.id), creator: owner };
      }),
    );
    const allowed = key.propertyIds.length ? propertyIds.filter((id) => key.propertyIds.includes(id)) : propertyIds;
    req.partner = {
      keyId: key.id,
      name: key.name,
      environment: key.environment as 'LIVE' | 'TEST',
      tenantId: key.tenantId,
      tenantName,
      scopes: key.scopes,
      propertyIds: allowed,
      restricted: key.propertyIds.length > 0,
    };
    const user: AuthUser = {
      userId: creator?.id ?? key.createdById ?? key.id,
      tenantId: key.tenantId,
      role: 'MANAGER',
      email: creator?.email ?? '',
      fullName: `API key ${key.name}`,
      permissions: permissionsForScopes(key.scopes),
      propertyIds: allowed,
      allProperties: !key.propertyIds.length,
      apiKey: { id: key.id, name: key.name, environment: key.environment as 'LIVE' | 'TEST' },
    };
    req.user = user;
    return true;
  }
}

/**
 * Runs partner handlers in the key's context: audit actor "API key <name>",
 * property scope of the key, dry-run for test keys (writes are validated,
 * then rolled back; the would-be result is returned with `dryRun: true`),
 * and the `{ data }` envelope.
 */
@Injectable()
export class PartnerInterceptor implements NestInterceptor {
  intercept(ctx: ExecutionContext, next: CallHandler): Observable<unknown> {
    const req = ctx.switchToHttp().getRequest<PartnerRequest>();
    const p = req.partner;
    if (!p) return next.handle();
    const write = !SAFE.has(req.method.toUpperCase());
    const dry = write && p.environment === 'TEST';
    const scope = { tenantId: p.tenantId, propertyId: p.propertyIds[0] ?? null, propertyIds: p.propertyIds };
    const run = (fn: () => void) =>
      apiKeyContext.run({ apiKeyId: p.keyId, name: p.name, environment: p.environment }, () =>
        propertyScopeStore.run(scope, () => (dry ? dryRunContext.run({ tenantId: p.tenantId }, fn) : fn())),
      );
    const handled = new Observable<unknown>((subscriber) => run(() => next.handle().subscribe(subscriber)));
    const wrap = (body: unknown) => {
      if (body && typeof body === 'object' && 'data' in (body as object)) return dry ? { ...(body as object), dryRun: true } : body;
      return dry ? { data: body, dryRun: true } : { data: body };
    };
    return handled.pipe(
      map(wrap),
      catchError((err: unknown) => {
        if (err instanceof DryRunRollback) {
          const mapper = (req as PartnerRequest & { partnerDryRunMap?: (v: unknown) => unknown }).partnerDryRunMap;
          return from(Promise.resolve(mapper ? mapper(err.result) : err.result)).pipe(map((v) => ({ data: v, dryRun: true })));
        }
        return throwError(() => err);
      }),
    );
  }
}

/** Marks the response of a handler that already returns `{ data, pagination }`. */
export const passThrough = <T>(v: T) => of(v);
