import { Body, Controller, Delete, Get, HttpCode, Param, ParseUUIDPipe, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { IsIn, IsString, MaxLength, MinLength } from 'class-validator';
import type { AuthUser } from '../../common/auth-types.js';
import { ClientIp, CurrentUser, RequirePermission } from '../../common/decorators/index.js';
import { RequireFeature } from '../entitlements/entitlements.decorators.js';
import { DomainsService } from './domains.service.js';

export class DomainDto {
  @IsString() @MinLength(3) @MaxLength(253) domain!: string;
}

export class DevDnsDto {
  @IsString() @MinLength(3) @MaxLength(253) name!: string;
  @IsIn(['TXT', 'CNAME']) type!: 'TXT' | 'CNAME';
  @IsString() @MinLength(1) @MaxLength(500) value!: string;
}

@ApiTags('Custom domain')
@ApiBearerAuth()
@RequireFeature('custom_domain')
@Controller('domains')
export class DomainsController {
  constructor(private readonly domains: DomainsService) {}

  @Get() @RequirePermission('settings.manage')
  get(@CurrentUser() u: AuthUser) { return this.domains.get(u); }

  @Post() @RequirePermission('settings.manage')
  create(@CurrentUser() u: AuthUser, @Body() dto: DomainDto, @ClientIp() ip?: string) { return this.domains.create(u, dto.domain, ip); }

  @Post('dev/dns') @RequirePermission('settings.manage') @HttpCode(200)
  @ApiOperation({ summary: 'Development only (DNS_PROVIDER=mock): add a record to the mock DNS' })
  devDns(@Body() dto: DevDnsDto) { return this.domains.devDns(dto); }

  @Post(':id/verify') @RequirePermission('settings.manage') @HttpCode(200)
  verify(@CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string) { return this.domains.verify(u, id); }

  @Post(':id/dev/publish') @RequirePermission('settings.manage') @HttpCode(200)
  @ApiOperation({ summary: 'Development only (DNS_PROVIDER=mock): publish the expected records in the mock DNS' })
  devPublish(@CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string) { return this.domains.devPublish(u, id); }

  @Delete(':id') @RequirePermission('settings.manage')
  remove(@CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string, @ClientIp() ip?: string) { return this.domains.remove(u, id, ip); }
}
