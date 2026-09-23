import { CallHandler, ExecutionContext, Injectable, NestInterceptor } from '@nestjs/common';
import type { Response } from 'express';
import { Observable } from 'rxjs';
import type { AppRequest } from './auth-types.js';
import { propertyScopeStore } from './property-scope.js';

/**
 * Runs every staff request inside its property scope (see
 * common/property-scope.ts) and echoes the property in the
 * `X-Property-Id` response header. The PermissionGuard has already
 * validated the property against the user's access.
 */
@Injectable()
export class PropertyScopeInterceptor implements NestInterceptor {
  intercept(ctx: ExecutionContext, next: CallHandler): Observable<unknown> {
    if (ctx.getType() !== 'http') return next.handle();
    const req = ctx.switchToHttp().getRequest<AppRequest>();
    const user = req.user;
    if (!user?.propertyId) return next.handle();
    ctx.switchToHttp().getResponse<Response>().setHeader('X-Property-Id', user.propertyId);
    const scope = { tenantId: user.tenantId, propertyId: user.propertyId, propertyIds: [user.propertyId] };
    return new Observable<unknown>((subscriber) => propertyScopeStore.run(scope, () => next.handle().subscribe(subscriber)));
  }
}
