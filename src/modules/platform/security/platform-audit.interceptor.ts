import { CallHandler, ExecutionContext, Injectable, NestInterceptor } from '@nestjs/common';
import type { Response } from 'express';
import { catchError, Observable, tap, throwError } from 'rxjs';
import type { AppRequest } from '../../../common/auth-types.js';
import { PlatformAuditService, redact } from './platform-audit.service.js';

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

/**
 * Records every mutating platform request (M6) in the append-only platform
 * audit log: who, what path, the (redacted) body, the outcome status. Domain
 * events (logins, impersonation...) are recorded by the services as well.
 */
@Injectable()
export class PlatformAuditInterceptor implements NestInterceptor {
  constructor(private readonly audit: PlatformAuditService) {}

  intercept(ctx: ExecutionContext, next: CallHandler): Observable<unknown> {
    if (ctx.getType() !== 'http') return next.handle();
    const req = ctx.switchToHttp().getRequest<AppRequest>();
    const p = req.platformUser;
    if (!p || ['GET', 'HEAD', 'OPTIONS'].includes(req.method.toUpperCase())) return next.handle();
    const path = (req.originalUrl ?? req.url).split('?')[0] ?? '';
    const tenantMatch = /\/platform\/tenants\/([0-9a-f-]{36})/i.exec(path);
    const targetId = UUID.exec(path.replace(/\/platform\/tenants\/[0-9a-f-]{36}/i, ''))?.[0] ?? tenantMatch?.[1] ?? null;
    const segments = path.replace(/^\/api\/v1\/platform\//, '').split('/').filter((x) => x && !UUID.test(x));
    const write = (statusCode: number, error?: string) =>
      void this.audit.record({
        actor: p,
        action: `request.${req.method.toUpperCase()}.${segments.join('.')}`.slice(0, 120),
        targetType: segments[0] ?? null,
        targetId,
        tenantId: tenantMatch?.[1] ?? null,
        method: req.method.toUpperCase(),
        path,
        statusCode,
        ip: req.ip,
        userAgent: req.headers['user-agent'] ?? null,
        metadata: { body: redact(req.body ?? {}), ...(error && { error }) },
      });
    return next.handle().pipe(
      tap(() => write(ctx.switchToHttp().getResponse<Response>().statusCode)),
      catchError((err: { status?: number; getStatus?: () => number; message?: string }) => {
        write(typeof err.getStatus === 'function' ? err.getStatus() : (err.status ?? 500), err.message);
        return throwError(() => err);
      }),
    );
  }
}
