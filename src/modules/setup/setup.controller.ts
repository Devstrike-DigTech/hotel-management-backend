import { Body, Controller, Get, HttpCode, Param, Post, Put } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { IsBoolean, IsIn, IsOptional } from 'class-validator';
import type { AuthUser } from '../../common/auth-types.js';
import { ClientIp, CurrentUser, RequirePermission } from '../../common/decorators/index.js';
import { PRESET_IDS } from '../booking-form/form.catalogue.js';
import { SetupService } from './setup.service.js';

export class StepDto {
  @IsIn(['DONE', 'SKIPPED', 'TODO']) status!: 'DONE' | 'SKIPPED' | 'TODO';
}

export class HotelTypeDto {
  @IsIn(PRESET_IDS) hotelType!: (typeof PRESET_IDS)[number];
  @IsOptional() @IsBoolean() applyFormPreset?: boolean;
  @IsOptional() @IsBoolean() applyTemplate?: boolean;
}

export class GoLiveDto {
  @IsOptional() @IsBoolean() publishTheme?: boolean;
  @IsOptional() @IsBoolean() publishForm?: boolean;
  @IsOptional() @IsBoolean() listOnMarketplace?: boolean;
}

@ApiTags('Setup wizard')
@ApiBearerAuth()
@Controller('setup')
export class SetupController {
  constructor(private readonly setup: SetupService) {}

  @Get() @RequirePermission('settings.manage')
  get(@CurrentUser() u: AuthUser) {
    return this.setup.get(u);
  }

  @Post('hotel-type') @RequirePermission('settings.manage') @HttpCode(200)
  hotelType(@CurrentUser() u: AuthUser, @Body() dto: HotelTypeDto, @ClientIp() ip?: string) {
    return this.setup.hotelType(u, dto, ip);
  }

  @Put('steps/:key') @RequirePermission('settings.manage')
  step(@CurrentUser() u: AuthUser, @Param('key') key: string, @Body() dto: StepDto, @ClientIp() ip?: string) {
    return this.setup.setStep(u, key, dto.status, ip);
  }

  @Post('go-live') @RequirePermission('settings.manage') @HttpCode(200)
  goLive(@CurrentUser() u: AuthUser, @Body() dto: GoLiveDto, @ClientIp() ip?: string) {
    return this.setup.goLive(u, dto, ip);
  }
}
