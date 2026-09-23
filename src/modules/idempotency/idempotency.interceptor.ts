import { CallHandler, ExecutionContext, HttpStatus, Injectable, NestInterceptor, StreamableFile } from '@nestjs/common';
import { HTTP_CODE_METADATA } from '@nestjs/common/constants.js';
import { Reflector } from '@nestjs/core';
import type { Response } from 'express';
import { createHash } from 'node:crypto';
import { from, mergeMap, Observable, of, catchError, throwError } from 'rxjs';
import type { Prisma } from '../../generated/prisma/client.js';
import type { AppRequest } from '../../common/auth-types.js';
import { AppException, ErrorCode } from '../../common/errors/app-exception.js';
import { DbService } from '../../prisma/db.service.js';
import { isUniqueViolation } from '../ops/ops.helpers.js';

export const IDEMPOTENCY_HEADER = 'idempotency-key';
export const REPLAY_HEADER = 'Idempotent-Replayed';
const KEY_RE = /^[A-Za-z0-9_.:-]{8,128}$/;
export const IDEMPOTENCY_TTL_MS = 72 * 3_600_000;
const SAFE = new Set(['GET', 'HEAD', 'OPTIONS']);

/** Stable JSON: object keys sorted, so field order does not change the fingerprint. */
export function stableStringify(v: unknown): string {
  if (v === null || typeof v !== 'object') return JSON.stringify(v) ?? 'null';
  if (Array.isArray(v)) return `[${v.map(stableStringify).join(',')}]`;
  const o = v as Record<string, unknown>;
  return `{${Object.keys(o)
    .sort()
    .filter((k) => o[k] !== undefined)
    .map((k) => `${JSON.stringify(k)}:${stableStringify(o[k])}`)
    .join(',')}}`;
}

export function fingerprint(method: string, path: string, body: unknown): string {
  const bodyHash = createHash('sha256').update(stableStringify(body ?? {})).digest('hex');
  return createHash('sha256').update(`${method.toUpperCase()} ${path} ${bodyHash}`).digest('hex');
}

/**
 * Offline-safe retries. A mutating hotel request carrying `Idempotency-Key`
 * runs once per (tenant, key); a 2xx result is stored for 72 hours and
 * replayed verbatim (with `Idempotent-Replayed: true`). Errors release the
 * key so the client can fix the cause and retry with the same key.
 */
@Injectable()
export class IdempotencyInterceptor implements NestInterceptor {
  constructor(
    private readonly db: DbService,
    private readonly reflector: Reflector,
  ) {}

  intercept(ctx: ExecutionContext, next: CallHandler): Observable<unknown> {
    if (ctx.getType() !== 'http') return next.handle();
    const req = ctx.switchToHttp().getRequest<AppRequest>();
    const res = ctx.switchToHttp().getResponse<Response>();
    const raw = req.headers[IDEMPOTENCY_HEADER];
    if (!raw || SAFE.has(req.method.toUpperCase()) || !req.user) return next.handle();
    const key = Array.isArray(raw) ? raw[0] : raw;
    if (!KEY_RE.test(key)) {
      throw new AppException(HttpStatus.BAD_REQUEST, ErrorCode.VALIDATION_ERROR, 'Idempotency-Key must be 8-128 characters of A-Z a-z 0-9 _ . : -', {
        fields: { 'Idempotency-Key': ['invalid format'] },
      });
    }
    const tenantId = req.user.tenantId;
    const path = (req.originalUrl ?? req.url).split('?')[0];
    const fp = fingerprint(req.method, `${path}?${(req.originalUrl ?? '').split('?')[1] ?? ''}`, req.body);
    const status =
      this.reflector.get<number | undefined>(HTTP_CODE_METADATA, ctx.getHandler()) ??
      (req.method.toUpperCase() === 'POST' ? HttpStatus.CREATED : HttpStatus.OK);

    return from(this.reserve(tenantId, key, fp)).pipe(
      mergeMap((stored) => {
        if (stored) {
          res.setHeader(REPLAY_HEADER, 'true');
          res.status(stored.status);
          return of(stored.body);
        }
        return next.handle().pipe(
          mergeMap((body) => from(this.complete(tenantId, key, status, body).then(() => body))),
          catchError((err) => from(this.release(tenantId, key)).pipe(mergeMap(() => throwError(() => err)))),
        );
      }),
    );
  }

  /** Returns the stored response to replay, or null after reserving the key for this request. */
  private async reserve(tenantId: string, key: string, fp: string): Promise<{ status: number; body: unknown } | null> {
    const now = new Date();
    try {
      return await this.db.tenant(tenantId, async (tx) => {
        const existing = await tx.idempotencyKey.findUnique({ where: { tenantId_key: { tenantId, key } } });
        if (existing && existing.expiresAt > now) {
          if (existing.fingerprint !== fp) {
            throw new AppException(
              HttpStatus.UNPROCESSABLE_ENTITY,
              'IDEMPOTENCY_CONFLICT',
              'This Idempotency-Key was already used for a different request',
            );
          }
          if (!existing.completed) {
            throw new AppException(HttpStatus.CONFLICT, 'IDEMPOTENCY_IN_PROGRESS', 'A request with this Idempotency-Key is still being processed');
          }
          return { status: existing.responseStatus ?? 200, body: existing.responseBody };
        }
        if (existing) await tx.idempotencyKey.delete({ where: { tenantId_key: { tenantId, key } } });
        await tx.idempotencyKey.create({
          data: { tenantId, key, fingerprint: fp, completed: false, expiresAt: new Date(now.getTime() + IDEMPOTENCY_TTL_MS) },
        });
        return null;
      });
    } catch (e) {
      if (isUniqueViolation(e)) {
        throw new AppException(HttpStatus.CONFLICT, 'IDEMPOTENCY_IN_PROGRESS', 'A request with this Idempotency-Key is still being processed');
      }
      throw e;
    }
  }

  private async complete(tenantId: string, key: string, status: number, body: unknown): Promise<void> {
    if (body instanceof StreamableFile || typeof body === 'string') {
      // Only JSON bodies are replayable; free the key for anything else.
      await this.release(tenantId, key);
      return;
    }
    const json = body === undefined ? null : (JSON.parse(JSON.stringify(body)) as Prisma.InputJsonValue);
    await this.db.tenant(tenantId, (tx) =>
      tx.idempotencyKey.update({
        where: { tenantId_key: { tenantId, key } },
        data: { completed: true, responseStatus: status, responseBody: json ?? undefined },
      }),
    );
  }

  private async release(tenantId: string, key: string): Promise<void> {
    await this.db
      .tenant(tenantId, (tx) => tx.idempotencyKey.deleteMany({ where: { tenantId, key, completed: false } }))
      .catch(() => undefined);
  }
}
