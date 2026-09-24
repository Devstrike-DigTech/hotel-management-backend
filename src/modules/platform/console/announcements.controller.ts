import { Body, Controller, Delete, Get, HttpCode, Param, ParseUUIDPipe, Patch, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { ArrayMaxSize, IsArray, IsBoolean, IsDateString, IsIn, IsOptional, IsString, MaxLength, MinLength, ValidateIf, ValidateNested } from 'class-validator';
import type { AuthUser, PlatformPrincipal } from '../../../common/auth-types.js';
import { AllowWhenReadOnly, CurrentPlatformUser, CurrentUser, GroupWide, PlatformOnly } from '../../../common/decorators/index.js';
import { PlatformPermissionRequired } from '../security/platform-permissions.js';
import { AnnouncementsService, SEVERITIES, type Audience } from './announcements.service.js';

class AudienceDto {
  @IsIn(['ALL', 'PLANS', 'CITIES', 'TENANTS']) kind!: 'ALL' | 'PLANS' | 'CITIES' | 'TENANTS';
  @IsOptional() @IsArray() @ArrayMaxSize(20) @IsString({ each: true }) planCodes?: string[];
  @IsOptional() @IsArray() @ArrayMaxSize(50) @IsString({ each: true }) cities?: string[];
  @IsOptional() @IsArray() @ArrayMaxSize(500) @IsString({ each: true }) tenantIds?: string[];
}

class ChannelsDto {
  @IsOptional() @IsBoolean() inApp?: boolean;
  @IsOptional() @IsBoolean() email?: boolean;
}

class LinkDto {
  @IsString() @MinLength(1) @MaxLength(40) label!: string;
  @IsString() @MaxLength(500) url!: string;
}

export class UpdateAnnouncementDto {
  @IsOptional() @IsString() @MinLength(3) @MaxLength(120) title?: string;
  @IsOptional() @IsString() @MinLength(1) @MaxLength(2000) body?: string;
  @IsOptional() @IsIn(SEVERITIES as unknown as string[]) severity?: string;
  @IsOptional() @ValidateNested() @Type(() => AudienceDto) audience?: AudienceDto;
  @IsOptional() @ValidateNested() @Type(() => ChannelsDto) channels?: ChannelsDto;
  @IsOptional() @IsDateString() startsAt?: string;
  @IsOptional() @ValidateIf((_o, v) => v !== null) @IsDateString() endsAt?: string | null;
  @IsOptional() @IsBoolean() dismissible?: boolean;
  @IsOptional() @ValidateIf((_o, v) => v !== null) @ValidateNested() @Type(() => LinkDto) link?: LinkDto | null;
}

export class CreateAnnouncementDto extends UpdateAnnouncementDto {
  @IsString() @MinLength(3) @MaxLength(120) declare title: string;
  @IsString() @MinLength(1) @MaxLength(2000) declare body: string;
}

export class AudiencePreviewDto {
  @ValidateNested() @Type(() => AudienceDto) audience!: AudienceDto;
}

function audienceOf(a: AudienceDto | undefined): Audience | undefined {
  if (!a) return undefined;
  switch (a.kind) {
    case 'PLANS':
      return { kind: 'PLANS', planCodes: a.planCodes ?? [] };
    case 'CITIES':
      return { kind: 'CITIES', cities: a.cities ?? [] };
    case 'TENANTS':
      return { kind: 'TENANTS', tenantIds: a.tenantIds ?? [] };
    default:
      return { kind: 'ALL' };
  }
}

@ApiTags('Platform: announcements')
@ApiBearerAuth()
@PlatformOnly()
@PlatformPermissionRequired('announcements.manage')
@Controller('platform/announcements')
export class PlatformAnnouncementsController {
  constructor(private readonly announcements: AnnouncementsService) {}

  @Get()
  list(@Query('state') state?: string) {
    return this.announcements.list(state);
  }

  @Post()
  create(@CurrentPlatformUser() p: PlatformPrincipal, @Body() dto: CreateAnnouncementDto) {
    return this.announcements.create(p, Object.assign({}, dto, { audience: audienceOf(dto.audience) }));
  }

  @Post('audience-preview') @HttpCode(200)
  preview(@Body() dto: AudiencePreviewDto) {
    return this.announcements.preview(audienceOf(dto.audience)!);
  }

  @Patch(':id')
  update(@Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateAnnouncementDto) {
    return this.announcements.update(id, Object.assign({}, dto, { audience: audienceOf(dto.audience) }));
  }

  @Post(':id/publish') @HttpCode(200)
  publish(@Param('id', ParseUUIDPipe) id: string) {
    return this.announcements.publish(id);
  }

  @Post(':id/end') @HttpCode(200)
  end(@Param('id', ParseUUIDPipe) id: string) {
    return this.announcements.end(id);
  }

  @Get(':id/stats')
  stats(@Param('id', ParseUUIDPipe) id: string) {
    return this.announcements.statsDetail(id);
  }

  @Delete(':id')
  archive(@Param('id', ParseUUIDPipe) id: string) {
    return this.announcements.archive(id);
  }
}

@ApiTags('Announcements')
@ApiBearerAuth()
@GroupWide()
@AllowWhenReadOnly()
@Controller('announcements')
export class HotelAnnouncementsController {
  constructor(private readonly announcements: AnnouncementsService) {}

  @Get()
  list(@CurrentUser() u: AuthUser) {
    return this.announcements.forHotel(u);
  }

  @Post(':id/seen') @HttpCode(200)
  seen(@CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.announcements.seen(u, id);
  }

  @Post(':id/dismiss') @HttpCode(200)
  dismiss(@CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.announcements.dismiss(u, id);
  }
}
