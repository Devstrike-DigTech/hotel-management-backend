import { HttpStatus, Injectable } from '@nestjs/common';
import type { CustomRole, Prisma } from '../../generated/prisma/client.js';
import type { StaffRole } from '../../generated/prisma/enums.js';
import type { AuthUser } from '../../common/auth-types.js';
import { AppException, ErrorCode } from '../../common/errors/app-exception.js';
import { permsOf } from '../../common/permissions/can.js';
import {
  ALL_PERMISSIONS,
  isPermission,
  isSystemRoleKey,
  missingFrom,
  PERMISSION_GROUPS,
  permissionsFor,
  SYSTEM_ROLES,
  systemRole,
} from '../../common/permissions/catalogue.js';
import { DbService, type Tx } from '../../prisma/db.service.js';
import { AuditService, userActor } from '../audit/audit.service.js';
import { EntitlementsService } from '../entitlements/entitlements.service.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface ResolvedRole {
  role: StaffRole;
  customRoleId: string | null;
  roleId: string;
  name: string;
  permissions: Set<string>;
}

export function escalation(missing: string[]) {
  return new AppException(HttpStatus.FORBIDDEN, 'PERMISSION_ESCALATION', 'You cannot grant permissions you do not have yourself', { missing });
}

/** Role label and id for a staff row. */
export function roleLabel(u: { role: StaffRole; customRoleId: string | null; customRole?: { name: string } | null }) {
  if (u.role === 'CUSTOM') return { roleId: u.customRoleId ?? '', roleName: u.customRole?.name ?? 'Custom role', system: false };
  return { roleId: u.role, roleName: systemRole(u.role)?.name ?? u.role, system: true };
}

/**
 * Roles: the built-in system roles (fixed permission sets in code) and the
 * hotel's custom roles (Growth+, `custom_roles`). Enforces the no-escalation
 * rule: nobody (except an owner) can create, edit or assign a role that has
 * permissions they lack.
 */
@Injectable()
export class RolesService {
  constructor(
    private readonly db: DbService,
    private readonly audit: AuditService,
    private readonly entitlements: EntitlementsService,
  ) {}

  catalogue() {
    return PERMISSION_GROUPS;
  }

  /** Resolves a role id (system key or custom role uuid) inside a transaction. */
  async resolve(tx: Tx, tenantId: string, roleId: string): Promise<ResolvedRole> {
    if (isSystemRoleKey(roleId)) {
      const def = systemRole(roleId)!;
      return { role: def.key, customRoleId: null, roleId: def.key, name: def.name, permissions: new Set(def.permissions) };
    }
    if (!UUID_RE.test(roleId)) throw validation('roleId', 'Unknown role');
    const r = await tx.customRole.findFirst({ where: { id: roleId, tenantId } });
    if (!r) throw validation('roleId', 'Unknown role');
    return { role: 'CUSTOM', customRoleId: r.id, roleId: r.id, name: r.name, permissions: permissionsFor('CUSTOM', r.permissions) };
  }

  /** Throws PERMISSION_ESCALATION unless the actor holds every permission in `wanted` (owners hold all). */
  assertNoEscalation(actor: AuthUser, wanted: Iterable<string>) {
    if (actor.role === 'OWNER') return;
    const missing = missingFrom(permsOf(actor), wanted);
    if (missing.length) throw escalation(missing);
  }

  private async counts(tx: Tx, tenantId: string): Promise<Map<string, number>> {
    const rows = await tx.user.groupBy({ by: ['role', 'customRoleId'], where: { tenantId }, _count: { _all: true } });
    const out = new Map<string, number>();
    for (const r of rows) {
      const key = r.role === 'CUSTOM' ? (r.customRoleId ?? '') : r.role;
      out.set(key, (out.get(key) ?? 0) + r._count._all);
    }
    return out;
  }

  private customView(r: CustomRole, staffCount: number) {
    return {
      id: r.id,
      key: null,
      name: r.name,
      description: r.description,
      system: false,
      permissions: r.permissions.filter(isPermission).sort(),
      staffCount,
      basedOn: r.basedOn,
      createdAt: r.createdAt.toISOString(),
      updatedAt: r.updatedAt.toISOString(),
    };
  }

  list(user: AuthUser) {
    return this.db.tenant(user.tenantId, async (tx) => {
      const counts = await this.counts(tx, user.tenantId);
      const custom = await tx.customRole.findMany({ where: { tenantId: user.tenantId }, orderBy: { name: 'asc' } });
      return [
        ...SYSTEM_ROLES.map((r) => ({
          id: r.key,
          key: r.key,
          name: r.name,
          description: r.description,
          system: true,
          permissions: [...r.permissions].sort(),
          staffCount: counts.get(r.key) ?? 0,
          basedOn: null,
          createdAt: null,
          updatedAt: null,
        })),
        ...custom.map((r) => this.customView(r, counts.get(r.id) ?? 0)),
      ];
    });
  }

  get(user: AuthUser, id: string) {
    return this.db.tenant(user.tenantId, async (tx) => {
      const all = await this.list(user);
      const role = all.find((r) => r.id === id);
      if (!role) throw AppException.notFound('Role');
      const staff = await tx.user.findMany({
        where: { tenantId: user.tenantId, ...(role.system ? { role: role.id as StaffRole } : { customRoleId: role.id }) },
        orderBy: { fullName: 'asc' },
        select: { id: true, fullName: true, email: true, isActive: true },
      });
      return { ...role, staff };
    });
  }

  private cleanPermissions(list: string[]): string[] {
    const bad = list.filter((c) => !isPermission(c));
    if (bad.length) throw validation('permissions', `Unknown permissions: ${bad.join(', ')}`);
    return [...new Set(list)].sort();
  }

  async create(user: AuthUser, dto: { name: string; description?: string; permissions?: string[]; cloneFrom?: string }, ip?: string) {
    return this.db.tenant(user.tenantId, async (tx) => {
      await this.entitlements.assertFeature(await this.entitlements.getEntitlements(user.tenantId, tx), 'custom_roles');
      let base: string[] = [];
      if (dto.cloneFrom) base = [...(await this.resolve(tx, user.tenantId, dto.cloneFrom)).permissions];
      const permissions = this.cleanPermissions(dto.permissions ?? base);
      this.assertNoEscalation(user, permissions);
      await this.assertNameFree(tx, user.tenantId, dto.name);
      const r = await tx.customRole.create({
        data: { tenantId: user.tenantId, name: dto.name.trim(), description: dto.description?.trim() ?? '', permissions, basedOn: dto.cloneFrom ?? null },
      });
      await this.audit.record(tx, {
        tenantId: user.tenantId,
        actor: userActor(user),
        action: 'role.created',
        entityType: 'role',
        entityId: r.id,
        metadata: { name: r.name, permissions, basedOn: dto.cloneFrom ?? null },
        ip,
      });
      return this.customView(r, 0);
    });
  }

  private async assertNameFree(tx: Tx, tenantId: string, name: string, exceptId?: string) {
    const clash = await tx.customRole.findFirst({
      where: { tenantId, name: { equals: name.trim(), mode: 'insensitive' }, ...(exceptId && { id: { not: exceptId } }) },
    });
    const systemClash = SYSTEM_ROLES.some((r) => r.name.toLowerCase() === name.trim().toLowerCase());
    if (clash || systemClash) throw AppException.conflict('A role with this name already exists');
  }

  async update(user: AuthUser, id: string, dto: { name?: string; description?: string; permissions?: string[] }, ip?: string) {
    if (isSystemRoleKey(id)) throw systemReadOnly(id);
    return this.db.tenant(user.tenantId, async (tx) => {
      await this.entitlements.assertFeature(await this.entitlements.getEntitlements(user.tenantId, tx), 'custom_roles');
      const r = UUID_RE.test(id) ? await tx.customRole.findFirst({ where: { id, tenantId: user.tenantId } }) : null;
      if (!r) throw AppException.notFound('Role');
      // You cannot edit a role that already holds more than you do.
      this.assertNoEscalation(user, r.permissions.filter(isPermission));
      const data: Prisma.CustomRoleUpdateInput = {};
      let added: string[] = [];
      let removed: string[] = [];
      if (dto.permissions) {
        const next = this.cleanPermissions(dto.permissions);
        this.assertNoEscalation(user, next);
        added = next.filter((c) => !r.permissions.includes(c));
        removed = r.permissions.filter((c) => !next.includes(c));
        data.permissions = next;
      }
      if (dto.name !== undefined && dto.name.trim() !== r.name) {
        await this.assertNameFree(tx, user.tenantId, dto.name, r.id);
        data.name = dto.name.trim();
      }
      if (dto.description !== undefined) data.description = dto.description.trim();
      const updated = await tx.customRole.update({ where: { id: r.id }, data });
      await this.audit.record(tx, {
        tenantId: user.tenantId,
        actor: userActor(user),
        action: 'role.updated',
        entityType: 'role',
        entityId: r.id,
        metadata: { name: updated.name, added, removed, ...(data.name && { renamedFrom: r.name }) },
        ip,
      });
      const counts = await this.counts(tx, user.tenantId);
      return this.customView(updated, counts.get(r.id) ?? 0);
    });
  }

  async remove(user: AuthUser, id: string, ip?: string) {
    if (isSystemRoleKey(id)) throw systemReadOnly(id);
    await this.db.tenant(user.tenantId, async (tx) => {
      await this.entitlements.assertFeature(await this.entitlements.getEntitlements(user.tenantId, tx), 'custom_roles');
      const r = UUID_RE.test(id) ? await tx.customRole.findFirst({ where: { id, tenantId: user.tenantId } }) : null;
      if (!r) throw AppException.notFound('Role');
      this.assertNoEscalation(user, r.permissions.filter(isPermission));
      const staffCount = await tx.user.count({ where: { tenantId: user.tenantId, customRoleId: r.id } });
      if (staffCount) {
        throw new AppException(HttpStatus.CONFLICT, 'ROLE_IN_USE', `${staffCount} staff member${staffCount === 1 ? ' has' : 's have'} this role; give them another role first`, { staffCount });
      }
      await tx.customRole.delete({ where: { id: r.id } });
      await this.audit.record(tx, {
        tenantId: user.tenantId,
        actor: userActor(user),
        action: 'role.deleted',
        entityType: 'role',
        entityId: r.id,
        metadata: { name: r.name },
        ip,
      });
    });
    return { success: true };
  }

  static readonly ALL = ALL_PERMISSIONS;
}

function validation(field: string, message: string) {
  return new AppException(HttpStatus.BAD_REQUEST, ErrorCode.VALIDATION_ERROR, message, { fields: { [field]: [message] } });
}

function systemReadOnly(roleId: string) {
  return new AppException(HttpStatus.CONFLICT, 'SYSTEM_ROLE_READ_ONLY', 'Built-in roles cannot be changed. Clone it into a custom role instead.', { roleId });
}
