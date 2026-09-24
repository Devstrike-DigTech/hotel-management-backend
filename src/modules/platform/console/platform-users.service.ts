import { HttpStatus, Injectable, Logger } from '@nestjs/common';
import { randomBytes } from 'node:crypto';
import type { PlatformRole, PlatformUser } from '../../../generated/prisma/client.js';
import type { PlatformPrincipal } from '../../../common/auth-types.js';
import { AppException } from '../../../common/errors/app-exception.js';
import { sha256Hex } from '../../../common/crypto/secret-box.js';
import { humanDate, lagosDate } from '../../../common/time/lagos.js';
import { AppConfigService } from '../../../config/app-config.service.js';
import { DbService } from '../../../prisma/db.service.js';
import { NotificationService } from '../../notifications/notification.service.js';
import { renderTemplate } from '../../notifications/templates/templates.js';
import { appError, Err } from '../../ops/ops.helpers.js';
import { NO_PASSWORD } from '../platform-auth.service.js';
import { isValidCidr } from '../security/cidr.js';
import { PLATFORM_ROLES } from '../security/platform-permissions.js';

const INVITE_DAYS = 7;

/** Console staff management (M6, `platform_users.manage`). */
@Injectable()
export class PlatformUsersService {
  private readonly logger = new Logger(PlatformUsersService.name);

  constructor(
    private readonly db: DbService,
    private readonly config: AppConfigService,
    private readonly notifications: NotificationService,
  ) {}

  private appUrl(): string {
    return (this.config.get('PLATFORM_APP_URL') ?? this.config.get('PLATFORM_ORIGINS')[0] ?? 'http://localhost:3002').replace(/\/$/, '');
  }

  private async row(u: PlatformUser) {
    const now = new Date();
    const activeSessions = await this.db.system((tx) => tx.platformSession.count({ where: { platformUserId: u.id, revokedAt: null, expiresAt: { gt: now } } }));
    return {
      id: u.id,
      email: u.email,
      fullName: u.fullName,
      role: u.role,
      isActive: u.isActive,
      mfaEnabled: !!u.totpSecretEnc,
      ipAllowlist: u.ipAllowlist,
      lockedUntil: u.lockedUntil && u.lockedUntil > now ? u.lockedUntil.toISOString() : null,
      lastLoginAt: u.lastLoginAt?.toISOString() ?? null,
      invitePending: !!u.inviteTokenHash,
      inviteExpiresAt: u.inviteExpiresAt?.toISOString() ?? null,
      createdAt: u.createdAt.toISOString(),
      activeSessions,
    };
  }

  private async load(id: string) {
    const u = await this.db.system((tx) => tx.platformUser.findUnique({ where: { id } }));
    if (!u) throw AppException.notFound('Platform user');
    return u;
  }

  async list() {
    const rows = await this.db.system((tx) => tx.platformUser.findMany({ orderBy: [{ isActive: 'desc' }, { fullName: 'asc' }] }));
    return Promise.all(rows.map((r) => this.row(r)));
  }

  private async sendInvite(u: PlatformUser, token: string, by: PlatformPrincipal) {
    const url = `${this.appUrl()}/invite/${token}`;
    const role = PLATFORM_ROLES.find((r) => r.role === u.role)?.label ?? u.role;
    const rendered = renderTemplate(
      { appName: this.config.get('APP_NAME'), appDomain: this.config.get('APP_DOMAIN'), supportEmail: this.config.get('SUPPORT_EMAIL') },
      { template: 'PLATFORM_INVITE', fullName: u.fullName, role, url, invitedBy: by.fullName, expiresHuman: humanDate(lagosDate(u.inviteExpiresAt ?? new Date())) },
    );
    await this.notifications
      .send([{ tenantId: null, template: 'PLATFORM_INVITE', channel: 'EMAIL', audience: 'PLATFORM', to: u.email, subject: rendered.subject, text: rendered.text, html: rendered.html }])
      .catch((e: Error) => this.logger.warn(`Invite email failed: ${e.message}`));
    return url;
  }

  async invite(p: PlatformPrincipal, dto: { email: string; fullName: string; role: PlatformRole }) {
    const email = dto.email.trim().toLowerCase();
    const token = randomBytes(24).toString('base64url');
    let u: PlatformUser;
    try {
      u = await this.db.system((tx) =>
        tx.platformUser.create({
          data: {
            email, fullName: dto.fullName.trim(), role: dto.role, passwordHash: NO_PASSWORD,
            inviteTokenHash: sha256Hex(`invite:${token}`), inviteExpiresAt: new Date(Date.now() + INVITE_DAYS * 86_400_000), invitedById: p.platformUserId,
          },
        }),
      );
    } catch (e) {
      if ((e as { code?: string }).code === 'P2002') throw appError(HttpStatus.CONFLICT, 'EMAIL_TAKEN', 'A console account with this email already exists');
      throw e;
    }
    const inviteUrl = await this.sendInvite(u, token, p);
    return { user: await this.row(u), inviteUrl };
  }

  async resendInvite(p: PlatformPrincipal, id: string) {
    const u = await this.load(id);
    if (u.passwordHash !== NO_PASSWORD) throw Err.invalidState('ACCEPTED', ['PENDING'], 'This invitation');
    const token = randomBytes(24).toString('base64url');
    const updated = await this.db.system((tx) =>
      tx.platformUser.update({ where: { id }, data: { inviteTokenHash: sha256Hex(`invite:${token}`), inviteExpiresAt: new Date(Date.now() + INVITE_DAYS * 86_400_000) } }),
    );
    return { inviteUrl: await this.sendInvite(updated, token, p) };
  }

  async update(p: PlatformPrincipal, id: string, dto: { role?: PlatformRole; isActive?: boolean; ipAllowlist?: string[]; fullName?: string }) {
    const u = await this.load(id);
    if (id === p.platformUserId && (dto.role !== undefined || dto.isActive === false)) {
      throw appError(HttpStatus.FORBIDDEN, 'PLATFORM_FORBIDDEN', 'You cannot change your own role or deactivate yourself', { permission: 'platform_users.manage' });
    }
    if (u.role === 'SUPER_ADMIN' && ((dto.role && dto.role !== 'SUPER_ADMIN') || dto.isActive === false)) {
      const others = await this.db.system((tx) => tx.platformUser.count({ where: { role: 'SUPER_ADMIN', isActive: true, NOT: { id } } }));
      if (!others) throw appError(HttpStatus.CONFLICT, 'LAST_SUPER_ADMIN', 'At least one active super admin must remain');
    }
    if (dto.ipAllowlist) {
      const bad = dto.ipAllowlist.filter((c) => !isValidCidr(c));
      if (bad.length) throw Err.validation('ipAllowlist', `Not a valid address or CIDR range: ${bad.join(', ')}`);
    }
    const updated = await this.db.system(async (tx) => {
      const x = await tx.platformUser.update({
        where: { id },
        data: {
          ...(dto.role !== undefined && { role: dto.role }),
          ...(dto.isActive !== undefined && { isActive: dto.isActive }),
          ...(dto.ipAllowlist !== undefined && { ipAllowlist: [...new Set(dto.ipAllowlist.map((c) => c.trim()))] }),
          ...(dto.fullName !== undefined && { fullName: dto.fullName.trim() }),
        },
      });
      if (dto.isActive === false || dto.role !== undefined) {
        await tx.platformSession.updateMany({ where: { platformUserId: id, revokedAt: null }, data: { revokedAt: new Date(), revokeReason: dto.isActive === false ? 'deactivated' : 'role_changed' } });
      }
      return x;
    });
    return this.row(updated);
  }

  async resetMfa(p: PlatformPrincipal, id: string) {
    await this.load(id);
    const updated = await this.db.system(async (tx) => {
      await tx.platformRecoveryCode.deleteMany({ where: { platformUserId: id } });
      await tx.platformSession.updateMany({ where: { platformUserId: id, revokedAt: null }, data: { revokedAt: new Date(), revokeReason: 'mfa_reset' } });
      return tx.platformUser.update({ where: { id }, data: { totpSecretEnc: null, totpPendingSecretEnc: null, mfaEnabledAt: null } });
    });
    return this.row(updated);
  }

  async unlock(id: string) {
    await this.load(id);
    const updated = await this.db.system((tx) => tx.platformUser.update({ where: { id }, data: { lockedUntil: null, failedAttempts: 0 } }));
    return this.row(updated);
  }

  async deactivate(p: PlatformPrincipal, id: string) {
    await this.update(p, id, { isActive: false });
    return { success: true };
  }
}
