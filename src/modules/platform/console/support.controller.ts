import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Patch, Post, Query, Req, Res, UploadedFile, UseInterceptors } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { ArrayMaxSize, IsArray, IsBoolean, IsIn, IsInt, IsOptional, IsString, IsUUID, Max, MaxLength, Min, MinLength, ValidateIf, ValidateNested } from 'class-validator';
import type { Response } from 'express';
import type { AppRequest, AuthUser, PlatformPrincipal } from '../../../common/auth-types.js';
import { AllowWhenReadOnly, CurrentPlatformUser, CurrentUser, GroupWide, PlatformOnly, Public } from '../../../common/decorators/index.js';
import type { UploadedFileLike } from '../../guests/guests.service.js';
import { PlatformPermissionRequired } from '../security/platform-permissions.js';
import { MAX_ATTACHMENT_BYTES, SUPPORT_CATEGORIES, SUPPORT_PRIORITIES, SUPPORT_STATUSES, SupportService } from './support.service.js';

class SupportContextDto {
  @IsOptional() @IsString() @MaxLength(500) pageUrl?: string;
  @IsOptional() @IsString() @MaxLength(40) appVersion?: string;
}

export class CreateSupportRequestDto {
  @IsString() @MinLength(3) @MaxLength(150) subject!: string;
  @IsIn(SUPPORT_CATEGORIES as unknown as string[]) category!: string;
  @IsString() @MinLength(1) @MaxLength(5000) message!: string;
  @IsOptional() @IsIn(SUPPORT_PRIORITIES as unknown as string[]) priority?: string;
  @IsOptional() @IsArray() @ArrayMaxSize(10) @IsString({ each: true }) attachmentKeys?: string[];
  @IsOptional() @ValidateNested() @Type(() => SupportContextDto) context?: SupportContextDto;
}

export class SupportMessageDto {
  @IsString() @MinLength(1) @MaxLength(5000) body!: string;
  @IsOptional() @IsArray() @ArrayMaxSize(10) @IsString({ each: true }) attachmentKeys?: string[];
}

export class PlatformSupportMessageDto extends SupportMessageDto {
  @IsOptional() @IsBoolean() internal?: boolean;
}

export class SupportListQueryDto {
  @IsOptional() @IsIn(SUPPORT_STATUSES as unknown as string[]) status?: string;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) page?: number;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(100) pageSize?: number;
}

export class PlatformSupportListQueryDto extends SupportListQueryDto {
  @IsOptional() @IsIn(SUPPORT_CATEGORIES as unknown as string[]) category?: string;
  @IsOptional() @IsIn(SUPPORT_PRIORITIES as unknown as string[]) priority?: string;
  @IsOptional() @IsString() @MaxLength(40) assigneeId?: string;
  @IsOptional() @IsUUID() tenantId?: string;
  @IsOptional() @IsIn(['ON_TRACK', 'DUE_SOON', 'BREACHED', 'MET', 'MISSED']) sla?: string;
  @IsOptional() @IsString() @MaxLength(120) q?: string;
}

export class UpdateSupportRequestDto {
  @IsOptional() @IsIn(SUPPORT_STATUSES as unknown as string[]) status?: string;
  @IsOptional() @IsIn(SUPPORT_PRIORITIES as unknown as string[]) priority?: string;
  @IsOptional() @IsIn(SUPPORT_CATEGORIES as unknown as string[]) category?: string;
  @IsOptional() @ValidateIf((_o, v) => v !== null) @IsUUID() assigneeId?: string | null;
}

const upload = () => UseInterceptors(FileInterceptor('file', { limits: { fileSize: MAX_ATTACHMENT_BYTES, files: 1 } }));

@ApiTags('Support')
@ApiBearerAuth()
@GroupWide()
@AllowWhenReadOnly()
@Controller('support')
export class HotelSupportController {
  constructor(private readonly support: SupportService) {}

  @Post('attachments') @upload()
  attach(@CurrentUser() u: AuthUser, @UploadedFile() file: UploadedFileLike & { originalname?: string }) {
    return this.support.upload({ kind: 'HOTEL', id: u.userId, tenantId: u.tenantId }, file);
  }

  @Post('requests')
  create(@CurrentUser() u: AuthUser, @Body() dto: CreateSupportRequestDto, @Req() req: AppRequest) {
    return this.support.create(u, dto, req);
  }

  @Get('requests')
  list(@CurrentUser() u: AuthUser, @Query() q: SupportListQueryDto) {
    return this.support.list(u, q);
  }

  @Get('summary')
  summary(@CurrentUser() u: AuthUser) {
    return this.support.summary(u);
  }

  @Get('requests/:id')
  get(@CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.support.get(u, id);
  }

  @Post('requests/:id/messages')
  reply(@CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body() dto: SupportMessageDto) {
    return this.support.hotelReply(u, id, dto);
  }

  @Post('requests/:id/close') @HttpCode(200)
  close(@CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.support.setHotelStatus(u, id, 'CLOSED');
  }

  @Post('requests/:id/reopen') @HttpCode(200)
  reopen(@CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.support.setHotelStatus(u, id, 'OPEN');
  }
}

@ApiTags('Support')
@Controller('public/support-files')
export class SupportFilesController {
  constructor(private readonly support: SupportService) {}

  @Get(':token') @Public()
  async file(@Param('token') token: string, @Res() res: Response) {
    const f = await this.support.readAttachment(token);
    res.setHeader('Content-Type', f.contentType);
    res.setHeader('Content-Disposition', `inline; filename="${f.name.replace(/"/g, '')}"`);
    res.setHeader('Cache-Control', 'private, max-age=300');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.send(f.body);
  }
}

@ApiTags('Platform: support desk')
@ApiBearerAuth()
@PlatformOnly()
@PlatformPermissionRequired('support.handle')
@Controller('platform/support')
export class PlatformSupportController {
  constructor(private readonly support: SupportService) {}

  @Get('requests')
  list(@CurrentPlatformUser() p: PlatformPrincipal, @Query() q: PlatformSupportListQueryDto) {
    return this.support.platformList(p, q);
  }

  @Get('summary')
  summary(@CurrentPlatformUser() p: PlatformPrincipal) {
    return this.support.platformSummary(p);
  }

  @Get('requests/:id')
  get(@Param('id', ParseUUIDPipe) id: string) {
    return this.support.platformGet(id);
  }

  @Patch('requests/:id')
  update(@CurrentPlatformUser() p: PlatformPrincipal, @Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateSupportRequestDto) {
    return this.support.platformUpdate(p, id, dto);
  }

  @Post('requests/:id/messages')
  reply(@CurrentPlatformUser() p: PlatformPrincipal, @Param('id', ParseUUIDPipe) id: string, @Body() dto: PlatformSupportMessageDto) {
    return this.support.platformReply(p, id, dto);
  }

  @Post('attachments') @upload()
  attach(@CurrentPlatformUser() p: PlatformPrincipal, @UploadedFile() file: UploadedFileLike & { originalname?: string }) {
    return this.support.upload({ kind: 'PLATFORM', id: p.platformUserId, tenantId: null }, file);
  }
}
