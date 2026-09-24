import { Injectable } from '@nestjs/common';
import type { AuthUser } from '../../common/auth-types.js';
import { AppException } from '../../common/errors/app-exception.js';
import { DbService } from '../../prisma/db.service.js';
import { EntitlementsService } from '../entitlements/entitlements.service.js';
import { permissionsFor } from '../../common/permissions/catalogue.js';
import { roleLabel } from '../staff/roles.service.js';
import { PropertyService } from '../property/property.service.js';
import { BrandingRegistry } from '../enterprise/white-label/branding.registry.js';
import { ImpersonationService } from '../platform/console/impersonation.service.js';

@Injectable()
export class MeService {
  constructor(
    private readonly db: DbService,
    private readonly entitlements: EntitlementsService,
    private readonly properties: PropertyService,
    private readonly branding: BrandingRegistry,
    private readonly impersonation: ImpersonationService,
  ) {}

  async get(auth: AuthUser) {
    // M6: control-plane extras (impersonation banner, white-label, SSO, database mode).
    const [impersonation, sso] = await Promise.all([
      this.impersonation.current(auth).catch(() => null),
      this.db.control(auth.tenantId, (tx) => tx.ssoConfig.findUnique({ where: { tenantId: auth.tenantId }, select: { enabled: true, enforced: true } })),
    ]);
    const brand = this.branding.get(auth.tenantId);
    const base = await this.db.tenant(auth.tenantId, async (tx) => {
      const user = await tx.user.findUnique({ where: { id: auth.userId }, include: { customRole: { select: { name: true, permissions: true } } } });
      const tenant = await tx.tenant.findUnique({ where: { id: auth.tenantId } });
      if (!user || !tenant || !user.isActive) {
        throw AppException.unauthorized('This account is no longer active');
      }
      const ent = await this.entitlements.getEntitlements(auth.tenantId, tx);
      // M5: properties and the one this request runs in.
      const properties = await this.properties.summaries(tx, auth);
      const currentProperty = properties.find((p) => p.id === auth.propertyId) ?? properties[0] ?? null;
      const allProperties = user.role === 'OWNER' || user.allProperties;
      const granted = allProperties ? [] : (await tx.userPropertyAccess.findMany({ where: { userId: user.id }, select: { propertyId: true } })).map((x) => x.propertyId);
      const group = await this.properties.group(tx, auth.tenantId);
      const usage = await this.entitlements.getUsage(auth.tenantId, tx);
      return {
        user: {
          id: user.id,
          fullName: user.fullName,
          email: user.email,
          phone: user.phone,
          role: user.role,
          ...(({ roleId, roleName }) => ({ roleId, roleName }))(roleLabel(user)),
          hasApprovalPin: !!user.approvalPinHash,
        },
        permissions: [...permissionsFor(user.role, user.customRole?.permissions)].sort(),
        tenant: { id: tenant.id, name: tenant.name, slug: tenant.slug },
        subscription: ent.subscription,
        entitlements: {
          features: ent.features,
          limits: ent.limits,
          usage,
        },
        currentProperty,
        properties,
        propertyAccess: { allProperties, propertyIds: granted },
        group,
        // M5: the property to use without a header, and whether an inaccessible X-Property-Id was ignored.
        suggestedPropertyId: auth.defaultPropertyId ?? currentProperty?.id ?? null,
        propertyHeaderIgnored: !!auth.propertyHeaderIgnored,
      };
    });
    return {
      ...base,
      impersonation,
      whiteLabel: { active: !!brand, brandName: brand?.brandName ?? null, logoUrl: brand?.logoUrl ?? null },
      sso: { enabled: !!sso?.enabled, enforced: !!sso?.enabled && !!sso.enforced },
      dedicatedDb: { mode: this.db.router.isDedicated(auth.tenantId) ? ('DEDICATED' as const) : ('SHARED' as const) },
    };
  }
}
