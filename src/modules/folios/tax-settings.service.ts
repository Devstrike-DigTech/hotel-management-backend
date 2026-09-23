import { Injectable } from '@nestjs/common';
import type { TaxSetting } from '../../generated/prisma/client.js';
import type { AuthUser } from '../../common/auth-types.js';
import { DbService, type Tx } from '../../prisma/db.service.js';
import { AuditService, userActor } from '../audit/audit.service.js';
import { primaryProperty } from '../ops/ops.helpers.js';
import type { UpdateTaxSettingsDto } from './folios.dto.js';

export function toTaxSettingsView(s: TaxSetting) {
  return {
    propertyId: s.propertyId,
    vat: { enabled: s.vatEnabled, rateBps: s.vatRateBps, inclusive: s.vatInclusive },
    consumptionTax: {
      enabled: s.consumptionEnabled,
      rateBps: s.consumptionRateBps,
      inclusive: s.consumptionInclusive,
      label: s.consumptionLabel,
    },
    serviceCharge: { enabled: s.serviceChargeEnabled, rateBps: s.serviceChargeRateBps, inclusive: s.serviceChargeInclusive },
    discountApprovalThresholdBps: s.discountApprovalThresholdBps,
    updatedAt: s.updatedAt.toISOString(),
  };
}

/** Per-property tax configuration; defaults (VAT 7.5% exclusive) are created on first use. */
@Injectable()
export class TaxSettingsService {
  constructor(
    private readonly db: DbService,
    private readonly audit: AuditService,
  ) {}

  async forProperty(tx: Tx, tenantId: string, propertyId: string): Promise<TaxSetting> {
    const existing = await tx.taxSetting.findUnique({ where: { propertyId } });
    if (existing) return existing;
    return tx.taxSetting.upsert({
      where: { propertyId },
      create: { tenantId, propertyId },
      update: {},
    });
  }

  async forTenant(tx: Tx, tenantId: string): Promise<TaxSetting> {
    const p = await primaryProperty(tx, tenantId);
    return this.forProperty(tx, tenantId, p.id);
  }

  get(user: AuthUser) {
    return this.db.tenant(user.tenantId, async (tx) => toTaxSettingsView(await this.forTenant(tx, user.tenantId)));
  }

  update(user: AuthUser, dto: UpdateTaxSettingsDto, ip?: string) {
    return this.db.tenant(user.tenantId, async (tx) => {
      const current = await this.forTenant(tx, user.tenantId);
      const updated = await tx.taxSetting.update({
        where: { id: current.id },
        data: {
          ...(dto.vat && {
            ...(dto.vat.enabled !== undefined && { vatEnabled: dto.vat.enabled }),
            ...(dto.vat.rateBps !== undefined && { vatRateBps: dto.vat.rateBps }),
            ...(dto.vat.inclusive !== undefined && { vatInclusive: dto.vat.inclusive }),
          }),
          ...(dto.consumptionTax && {
            ...(dto.consumptionTax.enabled !== undefined && { consumptionEnabled: dto.consumptionTax.enabled }),
            ...(dto.consumptionTax.rateBps !== undefined && { consumptionRateBps: dto.consumptionTax.rateBps }),
            ...(dto.consumptionTax.inclusive !== undefined && { consumptionInclusive: dto.consumptionTax.inclusive }),
            ...(dto.consumptionTax.label !== undefined && { consumptionLabel: dto.consumptionTax.label }),
          }),
          ...(dto.serviceCharge && {
            ...(dto.serviceCharge.enabled !== undefined && { serviceChargeEnabled: dto.serviceCharge.enabled }),
            ...(dto.serviceCharge.rateBps !== undefined && { serviceChargeRateBps: dto.serviceCharge.rateBps }),
            ...(dto.serviceCharge.inclusive !== undefined && { serviceChargeInclusive: dto.serviceCharge.inclusive }),
          }),
          ...(dto.discountApprovalThresholdBps !== undefined && {
            discountApprovalThresholdBps: dto.discountApprovalThresholdBps,
          }),
        },
      });
      await this.audit.record(tx, {
        tenantId: user.tenantId,
        actor: userActor(user),
        action: 'tax_settings.updated',
        entityType: 'tax_setting',
        entityId: updated.id,
        metadata: { before: toTaxSettingsView(current), after: toTaxSettingsView(updated) },
        ip,
      });
      return toTaxSettingsView(updated);
    });
  }
}
