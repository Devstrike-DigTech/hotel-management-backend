import { Controller, Get, Query, Res } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { IsIn, IsOptional, IsString, IsUUID, Matches, MaxLength } from 'class-validator';
import type { Response } from 'express';
import type { AuthUser } from '../../common/auth-types.js';
import { ClientIp, CurrentUser, RequirePermission } from '../../common/decorators/index.js';
import { PaginationQueryDto } from '../../common/utils/pagination.dto.js';
import { RequireFeature } from '../entitlements/entitlements.decorators.js';
import { AuditService } from './audit.service.js';

const DATE = /^\d{4}-\d{2}-\d{2}$/;

export class AuditQueryDto extends PaginationQueryDto {
  @IsOptional() @Matches(DATE) from?: string;
  @IsOptional() @Matches(DATE) to?: string;
  @IsOptional() @IsString() @MaxLength(80) action?: string;
  @IsOptional() @IsUUID() actorId?: string;
  @IsOptional() @IsString() @MaxLength(60) entityType?: string;
  /** M5 */
  @IsOptional() @IsUUID() propertyId?: string;
}

export class AuditExportDto {
  @Matches(DATE) from!: string;
  @Matches(DATE) to!: string;
  @IsOptional() @IsIn(['csv', 'json']) format?: 'csv' | 'json';
}

@ApiTags('Audit logs')
@ApiBearerAuth()
@Controller('audit-logs')
export class AuditController {
  constructor(private readonly audit: AuditService) {}

  @Get()
  @RequirePermission('audit.view')
  list(@CurrentUser() user: AuthUser, @Query() q: AuditQueryDto) {
    return this.audit.list(user.tenantId, q.page ?? 1, q.pageSize ?? 20, q);
  }

  @Get('export')
  @RequirePermission('audit.export')
  @RequireFeature('audit_export')
  @ApiOperation({ summary: 'Download the audit trail for a date range (CSV or JSON); the export is audited' })
  async export(@CurrentUser() user: AuthUser, @Query() q: AuditExportDto, @Res() res: Response, @ClientIp() ip?: string) {
    const out = await this.audit.export(user, q, ip);
    res.setHeader('Content-Type', out.contentType);
    res.setHeader('Content-Disposition', `attachment; filename="${out.filename}"`);
    res.send(out.body);
  }
}
