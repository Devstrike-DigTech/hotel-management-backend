import { CallHandler, ExecutionContext, Injectable, NestInterceptor } from '@nestjs/common';
import type { Response } from 'express';
import { catchError, Observable, tap, throwError } from 'rxjs';
import type { AppRequest } from '../../../common/auth-types.js';
import { impersonationContext } from '../../../common/impersonation-context.js';
import { PlatformAuditService, redact } from '../security/platform-audit.service.js';
import { ImpersonationService } from './impersonation.service.js';

const SAFE = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * Hotel requests made by Devstrike support (M6): the handler runs inside the
 * impersonation context (so every tenant audit row names the platform user),
 * the session counts its requests, and every write is mirrored in the
 * platform audit log.
 */
@Injectable()
export class ImpersonationInterceptor implements NestInterceptor {
  constructor(
    private readonly sessions: ImpersonationService,
    private readonly audit: PlatformAuditService,
  ) {}

  intercept(ctx: ExecutionContext, next: CallHandler): Observable<unknown> {
    if (ctx.getType() !== 'http') return next.handle();
    const req = ctx.switchToHttp().getRequest<AppRequest>();
    const imp = req.user?.impersonation;
    if (!imp || !req.user) return next.handle();
    const write = !SAFE.has(req.method.toUpperCase());
    const tenantId = req.user.tenantId;
    const path = (req.originalUrl ?? req.url).split('?')[0];
    const done = (statusCode: number) => {
      void this.sessions.count(imp.sessionId, write && statusCode < 400);
      if (write) {
        void this.audit.record({
          actor: { platformUserId: imp.platformUserId, fullName: imp.platformUserName, role: '' },
          action: 'impersonation.request',
          targetType: 'impersonation_session',
          targetId: imp.sessionId,
          tenantId,
          method: req.method.toUpperCase(),
          path,
          statusCode,
          ip: req.ip,
          metadata: { asUser: req.user!.fullName, body: redact(req.body ?? {}) },
        });
      }
    };
    const handled = new Observable<unknown>((subscriber) =>
      impersonationContext.run({ sessionId: imp.sessionId, platformUserId: imp.platformUserId, platformUserName: imp.platformUserName }, () => next.handle().subscribe(subscriber)),
    );
    return handled.pipe(
      tap(() => done(ctx.switchToHttp().getResponse<Response>().statusCode)),
      catchError((err: { getStatus?: () => number; status?: number }) => {
        done(typeof err.getStatus === 'function' ? err.getStatus() : (err.status ?? 500));
        return throwError(() => err);
      }),
    );
  }
}
