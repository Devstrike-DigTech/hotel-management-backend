import { Body, Controller, Delete, HttpStatus, Put } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import * as argon2 from 'argon2';
import { IsString, Matches, MaxLength } from 'class-validator';
import type { AuthUser } from '../../common/auth-types.js';
import { AllowWhenReadOnly, ClientIp, CurrentUser, RequirePermission } from '../../common/decorators/index.js';
import { AppException, ErrorCode } from '../../common/errors/app-exception.js';
import { DbService } from '../../prisma/db.service.js';
import { AuditService, userActor } from '../audit/audit.service.js';
import { argon2Options } from '../auth/auth.service.js';

export class SetPinDto {
  @IsString() @Matches(/^\d{4,6}$/, { message: 'pin must be 4 to 6 digits' }) pin!: string;
  @IsString() @MaxLength(200) currentPassword!: string;
}

@ApiTags('Me')
@ApiBearerAuth()
@RequirePermission('folio.approve')
@Controller('me/approval-pin')
export class ApprovalPinController {
  constructor(
    private readonly db: DbService,
    private readonly audit: AuditService,
  ) {}

  @Put()
  @AllowWhenReadOnly()
  @ApiOperation({ summary: 'Set your second-key approval PIN (managers and owners)' })
  async set(@CurrentUser() user: AuthUser, @Body() dto: SetPinDto, @ClientIp() ip?: string) {
    if (/^(\d)\1+$/.test(dto.pin) || '0123456789'.includes(dto.pin) || '9876543210'.includes(dto.pin)) {
      throw AppException.badRequest('Choose a PIN that is not a repeated digit or a simple sequence');
    }
    const hash = await argon2.hash(dto.pin, argon2Options);
    await this.db.tenant(user.tenantId, async (tx) => {
      const u = await tx.user.findUnique({ where: { id: user.userId } });
      if (!u) throw AppException.unauthorized();
      const ok = await argon2.verify(u.passwordHash, dto.currentPassword).catch(() => false);
      if (!ok) throw new AppException(HttpStatus.UNAUTHORIZED, ErrorCode.INVALID_CREDENTIALS, 'Your password is not correct');
      await tx.user.update({ where: { id: u.id }, data: { approvalPinHash: hash, pinFailedCount: 0, pinLockedUntil: null } });
      await this.audit.record(tx, { tenantId: user.tenantId, actor: userActor(user), action: 'staff.approval_pin_set', entityType: 'user', entityId: u.id, ip });
    });
    return { success: true };
  }

  @Delete()
  @AllowWhenReadOnly()
  async remove(@CurrentUser() user: AuthUser, @ClientIp() ip?: string) {
    await this.db.tenant(user.tenantId, async (tx) => {
      await tx.user.update({ where: { id: user.userId }, data: { approvalPinHash: null, pinFailedCount: 0, pinLockedUntil: null } });
      await this.audit.record(tx, { tenantId: user.tenantId, actor: userActor(user), action: 'staff.approval_pin_removed', entityType: 'user', entityId: user.userId, ip });
    });
    return { success: true };
  }
}
