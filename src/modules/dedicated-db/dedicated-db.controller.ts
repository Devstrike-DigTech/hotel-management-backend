import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { IsIn, IsOptional, IsString, MaxLength } from 'class-validator';
import type { AuthUser, PlatformPrincipal } from '../../common/auth-types.js';
import { ClientIp, CurrentPlatformUser, CurrentUser, PlatformOnly, RequirePermission } from '../../common/decorators/index.js';
import { RequireFeature } from '../entitlements/entitlements.decorators.js';
import { PlatformPermissionRequired, RequireStepUp, SuperAdminOnly } from '../platform/security/platform-permissions.js';
import { DbService } from '../../prisma/db.service.js';
import { ProvisioningService } from './provisioning.service.js';

export class ProvisionDto {
  @IsIn(['AUTO', 'URL'])
  source!: 'AUTO' | 'URL';

  @IsOptional() @IsString() @MaxLength(1000)
  url?: string;
}

@ApiTags('Platform: dedicated databases')
@ApiBearerAuth()
@PlatformOnly()
@Controller('platform')
export class PlatformDedicatedDbController {
  constructor(private readonly provisioning: ProvisioningService) {}

  @Get('dedicated-databases')
  @PlatformPermissionRequired('tenants.view')
  list() {
    return this.provisioning.list();
  }

  @Get('tenants/:id/database')
  @PlatformPermissionRequired('tenants.view')
  get(@Param('id', ParseUUIDPipe) id: string) {
    return this.provisioning.databaseView(id);
  }

  @Post('tenants/:id/database/provision')
  @PlatformPermissionRequired('dedicated_db.manage')
  @RequireStepUp()
  @HttpCode(202)
  @ApiOperation({ summary: 'Create, migrate, copy, verify and cut over to a dedicated database (poll the provisioning)' })
  provision(@CurrentPlatformUser() p: PlatformPrincipal, @Param('id', ParseUUIDPipe) id: string, @Body() dto: ProvisionDto, @ClientIp() ip?: string) {
    return this.provisioning.provision(p, id, dto, ip);
  }

  @Get('provisionings/:id')
  @PlatformPermissionRequired('tenants.view')
  provisioningRun(@Param('id', ParseUUIDPipe) id: string) {
    return this.provisioning.provisioning(id);
  }

  @Post('tenants/:id/database/rollback')
  @PlatformPermissionRequired('dedicated_db.manage')
  @RequireStepUp()
  @HttpCode(202)
  rollback(@CurrentPlatformUser() p: PlatformPrincipal, @Param('id', ParseUUIDPipe) id: string, @ClientIp() ip?: string) {
    return this.provisioning.rollback(p, id, ip);
  }

  @Post('tenants/:id/database/purge-shared')
  @PlatformPermissionRequired('dedicated_db.manage')
  @RequireStepUp()
  @HttpCode(200)
  async purge(@CurrentPlatformUser() p: PlatformPrincipal, @Param('id', ParseUUIDPipe) id: string, @ClientIp() ip?: string) {
    await this.provisioning.purgeShared(id, p, ip);
    return this.provisioning.databaseView(id);
  }

  @Post('databases/migrate-all')
  @SuperAdminOnly()
  @RequireStepUp()
  @HttpCode(200)
  migrateAll() {
    return this.provisioning.migrateAll();
  }
}

@ApiTags('Dedicated database')
@ApiBearerAuth()
@Controller('dedicated-database')
export class HotelDedicatedDbController {
  constructor(private readonly db: DbService) {}

  @Get()
  @RequireFeature('dedicated_database')
  @RequirePermission('settings.manage')
  async get(@CurrentUser() u: AuthUser) {
    const reg = await this.db.system((tx) => tx.tenantDatabase.findUnique({ where: { tenantId: u.tenantId } }));
    return {
      mode: (reg?.mode ?? 'SHARED') as 'SHARED' | 'DEDICATED',
      status: reg?.status ?? null,
      activatedAt: reg?.activatedAt?.toISOString() ?? null,
      region: reg?.host ? 'Dedicated instance' : null,
    };
  }
}
