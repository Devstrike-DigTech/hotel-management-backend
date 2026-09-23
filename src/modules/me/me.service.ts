import { Injectable } from '@nestjs/common';
import type { AuthUser } from '../../common/auth-types.js';
import { AppException } from '../../common/errors/app-exception.js';
import { DbService } from '../../prisma/db.service.js';
import { EntitlementsService } from '../entitlements/entitlements.service.js';

@Injectable()
export class MeService {
  constructor(
    private readonly db: DbService,
    private readonly entitlements: EntitlementsService,
  ) {}

  async get(auth: AuthUser) {
    return this.db.tenant(auth.tenantId, async (tx) => {
      const [user, tenant] = await Promise.all([
        tx.user.findUnique({ where: { id: auth.userId } }),
        tx.tenant.findUnique({ where: { id: auth.tenantId } }),
      ]);
      if (!user || !tenant || !user.isActive) {
        throw AppException.unauthorized('This account is no longer active');
      }
      const ent = await this.entitlements.getEntitlements(auth.tenantId, tx);
      const usage = await this.entitlements.getUsage(auth.tenantId, tx);
      return {
        user: {
          id: user.id,
          fullName: user.fullName,
          email: user.email,
          phone: user.phone,
          role: user.role,
        },
        tenant: { id: tenant.id, name: tenant.name, slug: tenant.slug },
        subscription: ent.subscription,
        entitlements: {
          features: ent.features,
          limits: ent.limits,
          usage,
        },
      };
    });
  }
}
