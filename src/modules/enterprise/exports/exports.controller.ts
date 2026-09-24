import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Post, Res } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { ArrayMaxSize, IsArray, IsIn, IsOptional } from 'class-validator';
import type { Response } from 'express';
import type { AuthUser, PlatformPrincipal } from '../../../common/auth-types.js';
import { AllowWhenReadOnly, ClientIp, CurrentPlatformUser, CurrentUser, GroupWide, PlatformOnly, Public, RequirePermission } from '../../../common/decorators/index.js';
import { RequireFeature } from '../../entitlements/entitlements.decorators.js';
import { PlatformPermissionRequired, RequireStepUp } from '../../platform/security/platform-permissions.js';
import { ExportsService } from './exports.service.js';

export class RequestExportDto {
  @IsOptional() @IsArray() @ArrayMaxSize(2) @IsIn(['json', 'csv'], { each: true })
  formats?: ('json' | 'csv')[];
}

@ApiTags('Data export')
@ApiBearerAuth()
@RequireFeature('data_export')
@GroupWide()
@Controller('exports')
export class ExportsController {
  constructor(private readonly exports: ExportsService) {}

  @Get() @RequirePermission('data.export')
  list(@CurrentUser() u: AuthUser) {
    return this.exports.list(u.tenantId);
  }

  @Post() @RequirePermission('data.export') @HttpCode(202) @AllowWhenReadOnly()
  request(@CurrentUser() u: AuthUser, @Body() dto: RequestExportDto, @ClientIp() ip?: string) {
    return this.exports.requestAsUser(u, dto.formats, ip);
  }

  @Get(':id') @RequirePermission('data.export')
  get(@CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.exports.get(u.tenantId, id);
  }

  @Post(':id/link') @RequirePermission('data.export') @HttpCode(200) @AllowWhenReadOnly()
  link(@CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string, @ClientIp() ip?: string) {
    return this.exports.link(u.tenantId, id, { kind: 'USER', id: u.userId, fullName: u.fullName }, ip);
  }
}

@ApiTags('Data export')
@Controller('public/exports')
export class PublicExportsController {
  constructor(private readonly exports: ExportsService) {}

  @Get(':token') @Public()
  async download(@Param('token') token: string, @Res() res: Response, @ClientIp() ip?: string) {
    const f = await this.exports.download(token, ip);
    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', `attachment; filename="${f.fileName.replace(/"/g, '')}"`);
    res.setHeader('Cache-Control', 'no-store');
    res.send(f.body);
  }
}

@ApiTags('Platform: exports')
@ApiBearerAuth()
@PlatformOnly()
@Controller('platform/tenants/:id/exports')
export class PlatformExportsController {
  constructor(private readonly exports: ExportsService) {}

  @Get() @PlatformPermissionRequired('tenants.view')
  list(@Param('id', ParseUUIDPipe) id: string) {
    return this.exports.list(id);
  }

  @Post() @PlatformPermissionRequired('tenants.manage') @RequireStepUp() @HttpCode(202)
  request(@CurrentPlatformUser() p: PlatformPrincipal, @Param('id', ParseUUIDPipe) id: string, @ClientIp() ip?: string) {
    return this.exports.requestAsPlatform(p, id, 'REQUEST', ip);
  }
}
