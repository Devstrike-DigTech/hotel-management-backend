import { Injectable } from '@nestjs/common';
import * as argon2 from 'argon2';
import type { PlatformPrincipal } from '../../common/auth-types.js';
import { AppException, ErrorCode } from '../../common/errors/app-exception.js';
import { DbService } from '../../prisma/db.service.js';
import { AuditService } from '../audit/audit.service.js';
import { TokenService } from '../auth/token.service.js';

const DUMMY = argon2.hash('timing-equaliser-not-a-password');

@Injectable()
export class PlatformAuthService {
  constructor(
    private readonly db: DbService,
    private readonly tokens: TokenService,
    private readonly audit: AuditService,
  ) {}

  async login(email: string, password: string, ip?: string) {
    // platform_users is readable only in the system context.
    const user = await this.db.system((tx) =>
      tx.platformUser.findUnique({ where: { email: email.toLowerCase() } }),
    );
    const ok = await argon2
      .verify(user?.passwordHash ?? (await DUMMY), password)
      .catch(() => false);
    if (!user || !ok || !user.isActive) {
      throw AppException.unauthorized(
        'Email or password is incorrect',
        ErrorCode.INVALID_CREDENTIALS,
      );
    }
    await this.db.system(async (tx) => {
      await tx.platformUser.update({
        where: { id: user.id },
        data: { lastLoginAt: new Date() },
      });
      await this.audit.record(tx, {
        tenantId: null,
        actor: { kind: 'platform', id: user.id, name: user.fullName },
        action: 'platform.login',
        entityType: 'platform_user',
        entityId: user.id,
        ip,
      });
    });
    const accessToken = await this.tokens.signPlatformAccess(user);
    return {
      accessToken,
      user: {
        id: user.id,
        fullName: user.fullName,
        email: user.email,
        role: user.role,
      },
    };
  }

  async me(p: PlatformPrincipal) {
    const user = await this.db.system((tx) =>
      tx.platformUser.findUnique({ where: { id: p.platformUserId } }),
    );
    if (!user || !user.isActive) throw AppException.unauthorized();
    return {
      id: user.id,
      fullName: user.fullName,
      email: user.email,
      role: user.role,
    };
  }
}
