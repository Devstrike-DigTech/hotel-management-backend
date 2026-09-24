import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Post, Put, Query, Res, UploadedFile, UseInterceptors } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import { Type } from 'class-transformer';
import { ArrayMaxSize, IsArray, IsIn, IsInt, IsObject, IsOptional, IsString, Length, Matches, Max, MaxLength, Min, ValidateNested } from 'class-validator';
import type { AuthUser } from '../../common/auth-types.js';
import { AnyPermission, ClientIp, CurrentUser, RequirePermission } from '../../common/decorators/index.js';
import { Err } from '../ops/ops.helpers.js';
import { diffDays, isIsoDate } from '../../common/time/lagos.js';
import { BookingFormService } from './booking-form.service.js';
import { CHANNELS, PRESET_IDS, type Channel, type FormField } from './form.catalogue.js';
import { MAX_FIELDS } from './form.logic.js';

export class SaveFormDto {
  @IsArray() @ArrayMaxSize(MAX_FIELDS + 10) @IsObject({ each: true }) fields!: Record<string, unknown>[];
}

export class CheckLabelDto {
  @IsString() @Length(1, 200) label!: string;
  @IsOptional() @IsString() @MaxLength(400) helpText?: string;
}

export class PresetDto {
  @IsIn(PRESET_IDS) presetId!: (typeof PRESET_IDS)[number];
}

export class NoteDto {
  @IsOptional() @IsString() @MaxLength(200) note?: string;
}

export class RenderQueryDto {
  @IsOptional() @IsIn(CHANNELS) channel?: Channel;
  @IsOptional() @IsIn(['published', 'draft']) source?: 'published' | 'draft';
}

export class GuestPartDto {
  @IsOptional() @IsString() @MaxLength(120) fullName?: string;
  @IsOptional() @IsString() @MaxLength(24) phone?: string;
  @IsOptional() @IsString() @MaxLength(160) email?: string;
}

export class ValidateFormDto {
  @IsIn(CHANNELS) channel!: Channel;
  @IsOptional() @IsIn(['published', 'draft']) source?: 'published' | 'draft';
  @IsOptional() @IsObject() answers?: Record<string, unknown>;
  @IsOptional() @IsIn(['ONLINE', 'PAY_AT_HOTEL']) paymentMode?: 'ONLINE' | 'PAY_AT_HOTEL';
  @IsOptional() @IsInt() @Min(1) @Max(10) adults?: number;
  @IsOptional() @IsInt() @Min(0) @Max(10) children?: number;
  @IsOptional() @ValidateNested() @Type(() => GuestPartDto) guest?: GuestPartDto;
}

export class ExportQueryDto {
  @Matches(/^\d{4}-\d{2}-\d{2}$/) from!: string;
  @Matches(/^\d{4}-\d{2}-\d{2}$/) to!: string;
  @IsOptional() @IsIn(['csv', 'json']) format?: 'csv' | 'json';
}

export class AnswersDto {
  @IsObject() answers!: Record<string, unknown>;
}

@ApiTags('Booking form')
@ApiBearerAuth()
@Controller('booking-form')
export class BookingFormController {
  constructor(private readonly forms: BookingFormService) {}

  @Get() @RequirePermission('forms.manage')
  get(@CurrentUser() u: AuthUser) {
    return this.forms.state(u);
  }

  @Get('library') @RequirePermission('forms.manage')
  library(@CurrentUser() u: AuthUser) {
    return this.forms.library(u);
  }

  @Get('presets') @AnyPermission('forms.manage', 'settings.manage')
  presets() {
    return this.forms.presets();
  }

  @Put('draft') @RequirePermission('forms.manage')
  save(@CurrentUser() u: AuthUser, @Body() dto: SaveFormDto, @ClientIp() ip?: string) {
    return this.forms.saveDraft(u, dto.fields as Partial<FormField>[], ip);
  }

  @Post('check-label') @RequirePermission('forms.manage') @HttpCode(200)
  @ApiOperation({ summary: 'ID-number guard for a label: OK, WARN (NIN, passport ...) or BLOCK (BVN)' })
  checkLabel(@Body() dto: CheckLabelDto) {
    return this.forms.checkLabel(dto.label, dto.helpText);
  }

  @Post('reset-to-preset') @RequirePermission('forms.manage') @HttpCode(200)
  reset(@CurrentUser() u: AuthUser, @Body() dto: PresetDto, @ClientIp() ip?: string) {
    return this.forms.resetToPreset(u, dto.presetId, ip);
  }

  @Post('publish') @RequirePermission('forms.manage') @HttpCode(200)
  publish(@CurrentUser() u: AuthUser, @Body() dto: NoteDto, @ClientIp() ip?: string) {
    return this.forms.publish(u, dto.note, ip);
  }

  @Post('discard') @RequirePermission('forms.manage') @HttpCode(200)
  discard(@CurrentUser() u: AuthUser) {
    return this.forms.discard(u);
  }

  @Get('versions') @RequirePermission('forms.manage')
  versions(@CurrentUser() u: AuthUser) {
    return this.forms.versions(u);
  }

  @Get('versions/:id') @RequirePermission('forms.manage')
  version(@CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.forms.version(u, id);
  }

  @Post('versions/:id/restore') @RequirePermission('forms.manage') @HttpCode(200)
  restore(@CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string, @ClientIp() ip?: string) {
    return this.forms.restore(u, id, ip);
  }

  @Get('render') @AnyPermission('forms.manage', 'reservations.create')
  @ApiOperation({ summary: 'The form for a channel: the front-desk drawer (published) or the builder preview (draft)' })
  render(@CurrentUser() u: AuthUser, @Query() q: RenderQueryDto) {
    return this.forms.render(u, q.channel ?? 'FRONT_DESK', q.source ?? 'published');
  }

  @Post('validate') @AnyPermission('forms.manage', 'reservations.create') @HttpCode(200)
  validate(@CurrentUser() u: AuthUser, @Body() dto: ValidateFormDto) {
    return this.forms.validateForStaff(u, dto);
  }

  @Post('uploads') @AnyPermission('reservations.create', 'reservations.edit')
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: 10 * 1024 * 1024, files: 1 } }))
  upload(@CurrentUser() u: AuthUser, @UploadedFile() file: { buffer: Buffer; size: number; originalname?: string } | undefined, @Body('fieldKey') fieldKey: string) {
    if (typeof fieldKey !== 'string' || !fieldKey) throw Err.validation('fieldKey', 'Give the key of the file question');
    return this.forms.uploadForDesk(u, fieldKey, file);
  }

  @Get('answers/export') @RequirePermission('reservations.view')
  async export(@CurrentUser() u: AuthUser, @Query() q: ExportQueryDto, @Res({ passthrough: true }) res: Response) {
    if (!isIsoDate(q.from) || !isIsoDate(q.to) || q.to < q.from) throw Err.validation('to', 'Give a valid date range');
    if (diffDays(q.from, q.to) > 366) throw Err.validation('to', 'The range can be at most a year');
    const data = await this.forms.exportAnswers(u, q);
    if (q.format === 'csv') {
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="booking-answers-${q.from}-to-${q.to}.csv"`);
      res.setHeader('Cache-Control', 'no-store');
      return BookingFormService.toCsv(data);
    }
    return data;
  }
}
