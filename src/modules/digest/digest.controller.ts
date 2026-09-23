import { Body, Controller, Get, HttpCode, Post, Put, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { ArrayMaxSize, IsArray, IsBoolean, IsOptional, IsString, Matches } from 'class-validator';
import type { AuthUser } from '../../common/auth-types.js';
import { ClientIp, CurrentUser, Roles } from '../../common/decorators/index.js';
import { PaginationQueryDto } from '../../common/utils/pagination.dto.js';
import { RequireFeature } from '../entitlements/entitlements.decorators.js';
import { DigestService } from './digest.service.js';

export class DigestSettingsDto {
  @IsBoolean() enabled!: boolean;
  @IsArray() @ArrayMaxSize(5) @IsString({ each: true }) recipients!: string[];
}

export class DigestDateDto {
  @IsOptional() @Matches(/^\d{4}-\d{2}-\d{2}$/) businessDate?: string;
}

@ApiTags('Owner digest')
@ApiBearerAuth()
@RequireFeature('owner_whatsapp_alerts')
@Controller('digests')
export class DigestController {
  constructor(private readonly digests: DigestService) {}

  @Get()
  @Roles('OWNER', 'MANAGER', 'ACCOUNTANT')
  list(@CurrentUser() user: AuthUser, @Query() q: PaginationQueryDto) {
    return this.digests.list(user, q.page, q.pageSize);
  }

  @Get('settings')
  @Roles('OWNER', 'MANAGER', 'ACCOUNTANT')
  settings(@CurrentUser() user: AuthUser) {
    return this.digests.getSettings(user);
  }

  @Put('settings')
  @Roles('OWNER', 'MANAGER')
  putSettings(@CurrentUser() user: AuthUser, @Body() dto: DigestSettingsDto, @ClientIp() ip?: string) {
    return this.digests.putSettings(user, dto, ip);
  }

  @Post('preview')
  @HttpCode(200)
  @Roles('OWNER', 'MANAGER', 'ACCOUNTANT')
  preview(@CurrentUser() user: AuthUser, @Body() dto: DigestDateDto) {
    return this.digests.preview(user, dto.businessDate);
  }

  @Post('send')
  @Roles('OWNER', 'MANAGER')
  send(@CurrentUser() user: AuthUser, @Body() dto: DigestDateDto) {
    return this.digests.sendNow(user, dto.businessDate);
  }
}
