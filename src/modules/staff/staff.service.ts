import { HttpStatus, Injectable } from '@nestjs/common';
import type { Prisma, User } from '../../generated/prisma/client.js';
import type { AuthUser } from '../../common/auth-types.js';
import { AppException, ErrorCode } from '../../common/errors/app-exception.js';
import { DbService, type Tx } from '../../prisma/db.service.js';
import { AuditService, userActor } from '../audit/audit.service.js';
import { AuthService, isUniqueViolation } from '../auth/auth.service.js';
import { EntitlementsService } from '../entitlements/entitlements.service.js';
import { permissionsFor } from '../../common/permissions/catalogue.js';
import { RolesService, roleLabel, type ResolvedRole } from './roles.service.js';
import type { CreateStaffDto, UpdateStaffDto } from './staff.dto.js';

type StaffRow = User & { customRole?: { name: string; permissions: string[] } | null; propertyAccess?: { propertyId: string }[] };
const withRole = { customRole: { select: { name: true, permissions: true } }, propertyAccess: { select: { propertyId: true } } } as const;

export function toStaffView(u: StaffRow) {
  const all = u.role === 'OWNER' || u.allProperties;
  return {
    id: u.id,
    fullName: u.fullName,
    email: u.email,
    phone: u.phone,
    role: u.role,
    ...roleLabel(u),
    isActive: u.isActive,
    lastLoginAt: u.lastLoginAt?.toISOString() ?? null,
    hasApprovalPin: !!u.approvalPinHash,
    createdAt: u.createdAt.toISOString(),
    // M5
    propertyAccess: { allProperties: all, propertyIds: all ? [] : (u.propertyAccess ?? []).map((a) => a.propertyId) },
  };
}

function escalation(missing: string[]) {
  return new AppException(HttpStatus.FORBIDDEN, 'PERMISSION_ESCALATION', 'You cannot grant access to properties you cannot access yourself', { missing });
}

const emailTaken = () =>
  new AppException(
    HttpStatus.CONFLICT,
    ErrorCode.EMAIL_TAKEN,
    'An account with this email already exists',
  );

@Injectable()
export class StaffService {
  constructor(
    private readonly db: DbService,
    private readonly audit: AuditService,
    private readonly entitlements: EntitlementsService,
    private readonly auth: AuthService,
    private readonly roles: RolesService,
  ) {}

  private lastOwner() {
    return new AppException(HttpStatus.CONFLICT, 'LAST_OWNER', 'A hotel must keep at least one active owner');
  }

  /** Role from `roleId` (system key or custom uuid) or the legacy `role` field. */
  private async roleFrom(tx: Tx, user: AuthUser, dto: { role?: string; roleId?: string }): Promise<ResolvedRole | null> {
    const ref = dto.roleId ?? dto.role;
    if (!ref) return null;
    if (ref === 'CUSTOM') {
      throw new AppException(HttpStatus.BAD_REQUEST, ErrorCode.VALIDATION_ERROR, 'Choose a custom role by its id (roleId)', { fields: { roleId: ['Choose a custom role by its id'] } });
    }
    const resolved = await this.roles.resolve(tx, user.tenantId, ref);
    if (resolved.role === 'CUSTOM') {
      await this.entitlements.assertFeature(await this.entitlements.getEntitlements(user.tenantId, tx), 'custom_roles');
    }
    return resolved;
  }

  /**
   * M5: validates and writes a staff member's property access. Owners
   * always have every property. You can only grant properties you can
   * access, and "all properties" only if you have it.
   */
  private async applyAccess(tx: Tx, user: AuthUser, targetId: string, targetRole: string, input: { allProperties?: boolean; propertyIds?: string[] }) {
    if (input.allProperties === undefined && input.propertyIds === undefined) return false;
    const all = input.allProperties ?? false;
    if (targetRole === 'OWNER') {
      if (!all) throw AppException.badRequest('Owners always have access to every property');
      return false;
    }
    const tenantProps = (await tx.property.findMany({ where: { tenantId: user.tenantId }, select: { id: true } })).map((p) => p.id);
    const ids = [...new Set((input.propertyIds ?? []).map((x) => x.toLowerCase()))];
    if (!all) {
      if (!ids.length) {
        throw new AppException(HttpStatus.BAD_REQUEST, ErrorCode.VALIDATION_ERROR, 'Choose at least one property', { fields: { propertyIds: ['Choose at least one property'] } });
      }
      const unknown = ids.filter((id) => !tenantProps.includes(id));
      if (unknown.length) {
        throw new AppException(HttpStatus.BAD_REQUEST, ErrorCode.VALIDATION_ERROR, 'Unknown property', { fields: { propertyIds: ['Unknown property'] } });
      }
    }
    const mine = user.propertyIds ?? tenantProps;
    const callerAll = user.role === 'OWNER' || user.allProperties !== false;
    if (all && !callerAll) throw escalation(['property:all']);
    const missing = ids.filter((id) => !mine.includes(id)).map((id) => `property:${id}`);
    if (missing.length) throw escalation(missing);
    await tx.userPropertyAccess.deleteMany({ where: { userId: targetId } });
    if (!all) await tx.userPropertyAccess.createMany({ data: ids.map((propertyId) => ({ tenantId: user.tenantId, userId: targetId, propertyId })) });
    await tx.user.update({ where: { id: targetId }, data: { allProperties: all } });
    return true;
  }

  /** PUT /staff/:id/property-access */
  setAccess(user: AuthUser, id: string, dto: { allProperties: boolean; propertyIds?: string[] }, ip?: string) {
    return this.db.tenant(user.tenantId, async (tx) => {
      const target = await this.load(tx, user.tenantId, id);
      this.roles.assertNoEscalation(user, permissionsFor(target.role, target.customRole?.permissions));
      await this.applyAccess(tx, user, id, target.role, dto);
      await this.audit.record(tx, {
        tenantId: user.tenantId,
        actor: userActor(user),
        action: 'staff.property_access',
        entityType: 'user',
        entityId: id,
        metadata: { fullName: target.fullName, allProperties: dto.allProperties, propertyIds: dto.propertyIds ?? [] },
        ip,
      });
      return toStaffView(await this.load(tx, user.tenantId, id));
    });
  }

  list(user: AuthUser) {
    return this.db.tenant(user.tenantId, async (tx) => {
      const rows = await tx.user.findMany({
        where: { tenantId: user.tenantId },
        orderBy: [{ isActive: 'desc' }, { createdAt: 'asc' }],
        include: withRole,
      });
      return rows.map(toStaffView);
    });
  }

  /** Active managers and owners who can approve with a PIN (second key). */
  approvers(user: AuthUser) {
    return this.db.tenant(user.tenantId, async (tx) => {
      const rows = await tx.user.findMany({
        where: { tenantId: user.tenantId, isActive: true, approvalPinHash: { not: null } },
        orderBy: { fullName: 'asc' },
        select: { id: true, fullName: true, role: true, customRole: { select: { permissions: true } } },
      });
      return rows
        .filter((r) => permissionsFor(r.role, r.customRole?.permissions).has('folio.approve'))
        .map((r) => ({ id: r.id, fullName: r.fullName, role: r.role }));
    });
  }

  async create(user: AuthUser, dto: CreateStaffDto, ip?: string) {
    if (!dto.role && !dto.roleId) {
      throw new AppException(HttpStatus.BAD_REQUEST, ErrorCode.VALIDATION_ERROR, 'Choose a role', { fields: { roleId: ['Choose a role'] } });
    }
    if ((dto.roleId ?? dto.role) === 'OWNER' && user.role !== 'OWNER') {
      throw AppException.forbidden('Only an owner can add another owner');
    }
    const passwordHash = await this.auth.hashPassword(dto.password);
    try {
      return await this.db.tenant(user.tenantId, async (tx) => {
        const role = (await this.roleFrom(tx, user, dto))!;
        this.roles.assertNoEscalation(user, role.permissions);
        const ent = await this.entitlements.getEntitlements(user.tenantId, tx);
        await this.entitlements.assertWithinLimit(ent, 'max_staff', 1, tx);
        const created = await tx.user.create({
          data: {
            tenantId: user.tenantId,
            email: dto.email,
            fullName: dto.fullName,
            phone: dto.phone,
            role: role.role,
            customRoleId: role.customRoleId,
            passwordHash,
          },
          include: withRole,
        });
        if (await this.applyAccess(tx, user, created.id, role.role, dto)) {
          Object.assign(created, await this.load(tx, user.tenantId, created.id));
        }
        await this.audit.record(tx, {
          tenantId: user.tenantId,
          actor: userActor(user),
          action: 'staff.created',
          entityType: 'user',
          entityId: created.id,
          metadata: { fullName: created.fullName, role: role.role, roleName: role.name, ...(role.customRoleId && { customRoleId: role.customRoleId }) },
          ip,
        });
        return toStaffView(created);
      });
    } catch (err) {
      if (isUniqueViolation(err, 'email')) throw emailTaken();
      throw err;
    }
  }

  private async load(tx: Tx, tenantId: string, id: string): Promise<StaffRow> {
    const u = await tx.user.findFirst({ where: { id, tenantId }, include: withRole });
    if (!u) throw AppException.notFound('Staff member');
    return u;
  }

  private async assertAnotherOwner(tx: Tx, tenantId: string, exceptId: string) {
    const owners = await tx.user.count({
      where: { tenantId, role: 'OWNER', isActive: true, id: { not: exceptId } },
    });
    if (owners === 0) throw this.lastOwner();
  }

  async update(user: AuthUser, id: string, dto: UpdateStaffDto, ip?: string) {
    const passwordHash = dto.password
      ? await this.auth.hashPassword(dto.password)
      : undefined;
    return this.db.tenant(user.tenantId, async (tx) => {
      const target = await this.load(tx, user.tenantId, id);
      const next = await this.roleFrom(tx, user, dto);
      const roleChanges = !!next && (next.role !== target.role || next.customRoleId !== target.customRoleId);
      const touchesOwner = target.role === 'OWNER' || next?.role === 'OWNER';
      if (touchesOwner && user.role !== 'OWNER') {
        throw AppException.forbidden('Only an owner can change an owner account');
      }
      // No escalation: you cannot change someone who holds more than you,
      // nor give them a role with more than you hold.
      this.roles.assertNoEscalation(user, permissionsFor(target.role, target.customRole?.permissions));
      if (next) this.roles.assertNoEscalation(user, next.permissions);
      const self = target.id === user.userId;
      if (self && (dto.isActive === false || roleChanges)) {
        throw AppException.badRequest(
          'You cannot deactivate yourself or change your own role',
        );
      }
      const losingOwner =
        target.role === 'OWNER' &&
        target.isActive &&
        ((roleChanges && next?.role !== 'OWNER') || dto.isActive === false);
      if (losingOwner) await this.assertAnotherOwner(tx, user.tenantId, id);

      if (dto.isActive === true && !target.isActive) {
        const ent = await this.entitlements.getEntitlements(user.tenantId, tx);
        await this.entitlements.assertWithinLimit(ent, 'max_staff', 1, tx);
      }

      const data: Prisma.UserUncheckedUpdateInput = {
        ...(dto.fullName !== undefined && { fullName: dto.fullName }),
        ...(dto.phone !== undefined && { phone: dto.phone }),
        ...(roleChanges && { role: next!.role, customRoleId: next!.customRoleId }),
        ...(dto.isActive !== undefined && { isActive: dto.isActive }),
        ...(passwordHash && { passwordHash }),
      };
      await tx.user.update({ where: { id }, data });
      await this.applyAccess(tx, user, id, next?.role ?? target.role, dto);
      const updated = await this.load(tx, user.tenantId, id);

      // Sign the user out everywhere when access is reduced or reset.
      if (passwordHash || dto.isActive === false || roleChanges) {
        await tx.refreshToken.updateMany({
          where: { userId: id, revokedAt: null },
          data: { revokedAt: new Date(), revokeReason: 'staff_updated' },
        });
      }

      await this.audit.record(tx, {
        tenantId: user.tenantId,
        actor: userActor(user),
        action: 'staff.updated',
        entityType: 'user',
        entityId: id,
        metadata: {
          fullName: updated.fullName,
          changes: Object.keys(dto).map((k) => (k === 'password' ? 'password' : k)),
          ...(roleChanges && { from: roleLabel(target).roleName, to: next!.name, fromRole: target.role, toRole: next!.role }),
        },
        ip,
      });
      return toStaffView(updated);
    });
  }

  async remove(user: AuthUser, id: string, ip?: string) {
    await this.db.tenant(user.tenantId, async (tx) => {
      const target = await this.load(tx, user.tenantId, id);
      if (target.id === user.userId) {
        throw AppException.badRequest('You cannot delete your own account');
      }
      if (target.role === 'OWNER') {
        if (user.role !== 'OWNER') {
          throw AppException.forbidden('Only an owner can remove an owner');
        }
        await this.assertAnotherOwner(tx, user.tenantId, id);
      }
      this.roles.assertNoEscalation(user, permissionsFor(target.role, target.customRole?.permissions));
      // Audit rows keep the actor's id and name snapshot, so hard delete is
      // safe; refresh tokens cascade.
      await tx.user.delete({ where: { id } });
      await this.audit.record(tx, {
        tenantId: user.tenantId,
        actor: userActor(user),
        action: 'staff.deleted',
        entityType: 'user',
        entityId: id,
        metadata: { fullName: target.fullName, email: target.email, role: target.role },
        ip,
      });
    });
    return { success: true };
  }
}
