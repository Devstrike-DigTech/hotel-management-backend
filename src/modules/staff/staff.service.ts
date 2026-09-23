import { HttpStatus, Injectable } from '@nestjs/common';
import type { Prisma, User } from '../../generated/prisma/client.js';
import type { AuthUser } from '../../common/auth-types.js';
import { AppException, ErrorCode } from '../../common/errors/app-exception.js';
import { DbService, type Tx } from '../../prisma/db.service.js';
import { AuditService, userActor } from '../audit/audit.service.js';
import { AuthService, isUniqueViolation } from '../auth/auth.service.js';
import { EntitlementsService } from '../entitlements/entitlements.service.js';
import type { CreateStaffDto, UpdateStaffDto } from './staff.dto.js';

export function toStaffView(u: User) {
  return {
    id: u.id,
    fullName: u.fullName,
    email: u.email,
    phone: u.phone,
    role: u.role,
    isActive: u.isActive,
    lastLoginAt: u.lastLoginAt?.toISOString() ?? null,
    createdAt: u.createdAt.toISOString(),
  };
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
  ) {}

  list(user: AuthUser) {
    return this.db.tenant(user.tenantId, async (tx) => {
      const rows = await tx.user.findMany({
        where: { tenantId: user.tenantId },
        orderBy: [{ isActive: 'desc' }, { createdAt: 'asc' }],
      });
      return rows.map(toStaffView);
    });
  }

  async create(user: AuthUser, dto: CreateStaffDto, ip?: string) {
    if (dto.role === 'OWNER' && user.role !== 'OWNER') {
      throw AppException.forbidden('Only an owner can add another owner');
    }
    const passwordHash = await this.auth.hashPassword(dto.password);
    try {
      return await this.db.tenant(user.tenantId, async (tx) => {
        const ent = await this.entitlements.getEntitlements(user.tenantId, tx);
        await this.entitlements.assertWithinLimit(ent, 'max_staff', 1, tx);
        const created = await tx.user.create({
          data: {
            tenantId: user.tenantId,
            email: dto.email,
            fullName: dto.fullName,
            phone: dto.phone,
            role: dto.role,
            passwordHash,
          },
        });
        await this.audit.record(tx, {
          tenantId: user.tenantId,
          actor: userActor(user),
          action: 'staff.created',
          entityType: 'user',
          entityId: created.id,
          metadata: { fullName: created.fullName, role: created.role },
          ip,
        });
        return toStaffView(created);
      });
    } catch (err) {
      if (isUniqueViolation(err, 'email')) throw emailTaken();
      throw err;
    }
  }

  private async load(tx: Tx, tenantId: string, id: string): Promise<User> {
    const u = await tx.user.findFirst({ where: { id, tenantId } });
    if (!u) throw AppException.notFound('Staff member');
    return u;
  }

  private async assertAnotherOwner(tx: Tx, tenantId: string, exceptId: string) {
    const owners = await tx.user.count({
      where: { tenantId, role: 'OWNER', isActive: true, id: { not: exceptId } },
    });
    if (owners === 0) {
      throw AppException.conflict('A hotel must keep at least one active owner');
    }
  }

  async update(user: AuthUser, id: string, dto: UpdateStaffDto, ip?: string) {
    const passwordHash = dto.password
      ? await this.auth.hashPassword(dto.password)
      : undefined;
    return this.db.tenant(user.tenantId, async (tx) => {
      const target = await this.load(tx, user.tenantId, id);
      const touchesOwner = target.role === 'OWNER' || dto.role === 'OWNER';
      if (touchesOwner && user.role !== 'OWNER') {
        throw AppException.forbidden('Only an owner can change an owner account');
      }
      const self = target.id === user.userId;
      if (self && (dto.isActive === false || (dto.role && dto.role !== target.role))) {
        throw AppException.badRequest(
          'You cannot deactivate yourself or change your own role',
        );
      }
      const losingOwner =
        target.role === 'OWNER' &&
        target.isActive &&
        ((dto.role !== undefined && dto.role !== 'OWNER') || dto.isActive === false);
      if (losingOwner) await this.assertAnotherOwner(tx, user.tenantId, id);

      if (dto.isActive === true && !target.isActive) {
        const ent = await this.entitlements.getEntitlements(user.tenantId, tx);
        await this.entitlements.assertWithinLimit(ent, 'max_staff', 1, tx);
      }

      const data: Prisma.UserUpdateInput = {
        ...(dto.fullName !== undefined && { fullName: dto.fullName }),
        ...(dto.phone !== undefined && { phone: dto.phone }),
        ...(dto.role !== undefined && { role: dto.role }),
        ...(dto.isActive !== undefined && { isActive: dto.isActive }),
        ...(passwordHash && { passwordHash }),
      };
      const updated = await tx.user.update({ where: { id }, data });

      // Sign the user out everywhere when access is reduced or reset.
      if (passwordHash || dto.isActive === false || (dto.role && dto.role !== target.role)) {
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
          ...(dto.role && dto.role !== target.role && { from: target.role, to: dto.role }),
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
