import { Body, Controller, Get, HttpCode, Param, Post, Query, Res, UploadedFile, UseInterceptors } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import { Type } from 'class-transformer';
import { IsBoolean, IsIn, IsInt, IsObject, IsOptional, IsString, Matches, Max, MaxLength, Min, ValidateNested } from 'class-validator';
import { Public } from '../../common/decorators/index.js';
import { AppException } from '../../common/errors/app-exception.js';
import { DbService } from '../../prisma/db.service.js';
import { PublicBookingService } from '../booking/public-booking.service.js';
import { BookingFormService } from '../booking-form/booking-form.service.js';
import { GuestPartDto } from '../booking-form/booking-form.controller.js';
import { AddOnsService } from '../extras/addons.service.js';
import { HotelQueryDto, PublicExtrasQueryDto } from '../extras/extras.dto.js';
import type { StayInfo } from '../extras/extras.logic.js';
import { ExtrasService } from '../extras/extras.service.js';
import { RateLimit } from '../infra/rate-limit.js';
import { Err } from '../ops/ops.helpers.js';
import { PreviewTokens } from './preview-tokens.js';
import { FONT_PAIRINGS, TEMPLATES } from './site.registry.js';
import { ThemeService } from './theme.service.js';

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export class PreviewQueryDto {
  @IsOptional() @IsString() @MaxLength(2000) preview?: string;
  @IsOptional() @IsString() @MaxLength(253) host?: string;
}

export class PublicFormQueryDto {
  @IsOptional() @IsIn(['MARKETPLACE', 'BOOKING_SITE']) channel?: 'MARKETPLACE' | 'BOOKING_SITE';
  @IsOptional() @IsString() @MaxLength(2000) preview?: string;
}

export class PublicValidateDto {
  @IsIn(['MARKETPLACE', 'BOOKING_SITE']) channel!: 'MARKETPLACE' | 'BOOKING_SITE';
  @IsOptional() @IsObject() answers?: Record<string, unknown>;
  @IsOptional() @IsIn(['ONLINE', 'PAY_AT_HOTEL']) paymentMode?: 'ONLINE' | 'PAY_AT_HOTEL';
  @IsOptional() @IsInt() @Min(1) @Max(10) adults?: number;
  @IsOptional() @IsInt() @Min(0) @Max(10) children?: number;
  @IsOptional() @ValidateNested() @Type(() => GuestPartDto) guest?: GuestPartDto;
  @IsOptional() @IsBoolean() consent?: boolean;
  @IsOptional() @Matches(DATE_RE) checkIn?: string;
  @IsOptional() @Matches(DATE_RE) checkOut?: string;
  @IsOptional() @IsString() @MaxLength(2000) preview?: string;
}

const MINUTE = 60;

/**
 * Public M7 endpoints for the web app: template registry, published (or
 * previewed) theme, booking form, step validation, file uploads, extras,
 * pickup points and the transport lists.
 */
@ApiTags('Public')
@Public()
@Controller('public')
export class PublicSiteController {
  constructor(
    private readonly themes: ThemeService,
    private readonly previews: PreviewTokens,
    private readonly forms: BookingFormService,
    private readonly addOns: AddOnsService,
    private readonly extras: ExtrasService,
    private readonly booking: PublicBookingService,
    private readonly db: DbService,
  ) {}

  @Get('site/templates')
  templates() {
    return TEMPLATES;
  }

  @Get('site/font-pairings')
  fontPairings() {
    return FONT_PAIRINGS;
  }

  @Get('hotels/:slug/theme')
  @RateLimit({ name: 'site', limit: 240, windowSec: MINUTE })
  @ApiOperation({ summary: 'Published booking-site theme (or the draft with ?preview=<token>)' })
  async theme(@Param('slug') slug: string, @Query() q: PreviewQueryDto, @Res({ passthrough: true }) res: Response) {
    if (q.preview) res.setHeader('X-Robots-Tag', 'noindex, nofollow');
    return this.themes.publicTheme(slug, q.preview);
  }

  @Get('groups/:slug/theme')
  @RateLimit({ name: 'site', limit: 240, windowSec: MINUTE })
  async groupTheme(@Param('slug') slug: string, @Query() q: PreviewQueryDto, @Res({ passthrough: true }) res: Response) {
    if (q.preview) res.setHeader('X-Robots-Tag', 'noindex, nofollow');
    return this.themes.publicGroupTheme(slug, q.preview);
  }

  /** The hotel and whether a preview token opens its draft form. */
  private async formRef(slug: string, preview?: string) {
    const ref = await this.themes.hotelRef(slug);
    if (!preview) return { ref, draft: false };
    const grant = this.previews.verify(preview, 'FORM');
    if (grant.tenantId !== ref.tenantId || grant.propertyId !== ref.id) throw AppException.notFound('Preview');
    return { ref, draft: true };
  }

  @Get('hotels/:slug/booking-form')
  @RateLimit({ name: 'site', limit: 240, windowSec: MINUTE })
  @ApiOperation({ summary: 'The published booking form for a channel (sections, fields, conditions, extras, pickup points)' })
  async form(@Param('slug') slug: string, @Query() q: PublicFormQueryDto, @Res({ passthrough: true }) res: Response) {
    const { ref, draft } = await this.formRef(slug, q.preview);
    if (draft) res.setHeader('X-Robots-Tag', 'noindex, nofollow');
    return this.forms.publicRender(ref, q.channel ?? 'BOOKING_SITE', draft);
  }

  @Post('hotels/:slug/booking-form/validate') @HttpCode(200)
  @RateLimit({ name: 'form-validate', limit: 60, windowSec: MINUTE })
  async validate(@Param('slug') slug: string, @Body() dto: PublicValidateDto) {
    const { ref, draft } = await this.formRef(slug, dto.preview);
    let stay: StayInfo | null = null;
    if (dto.checkIn && dto.checkOut) {
      if (dto.checkOut <= dto.checkIn) throw Err.validation('checkOut', 'Check-out must be after check-in');
      stay = await this.stayOf(ref, { checkIn: dto.checkIn, checkOut: dto.checkOut, adults: dto.adults, children: dto.children });
    }
    return this.forms.publicValidate(ref, dto, stay, draft);
  }

  @Post('hotels/:slug/booking-form/uploads')
  @RateLimit({ name: 'form-upload', limit: 20, windowSec: 10 * MINUTE })
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: 10 * 1024 * 1024, files: 1 } }))
  async upload(
    @Param('slug') slug: string,
    @UploadedFile() file: { buffer: Buffer; size: number; originalname?: string } | undefined,
    @Body('fieldKey') fieldKey: string,
    @Body('channel') channel: string,
    @Body('preview') preview?: string,
  ) {
    if (typeof fieldKey !== 'string' || !fieldKey) throw Err.validation('fieldKey', 'Give the key of the file question');
    const ch = channel === 'MARKETPLACE' ? 'MARKETPLACE' : 'BOOKING_SITE';
    const { ref, draft } = await this.formRef(slug, typeof preview === 'string' && preview ? preview : undefined);
    return this.forms.uploadPublic(ref, fieldKey, ch, draft, file);
  }

  private async stayOf(ref: { id: string; tenantId: string }, q: { checkIn?: string; checkOut?: string; date?: string; startTime?: string; hours?: number; adults?: number; children?: number }): Promise<StayInfo | null> {
    return this.db.tenant(ref.tenantId, async (tx) => {
      const p = await tx.property.findFirstOrThrow({ where: { id: ref.id } });
      return this.stayFor(p, q);
    });
  }

  private stayFor(p: { checkInTime: string; checkOutTime: string }, q: { checkIn?: string; checkOut?: string; date?: string; startTime?: string; hours?: number; adults?: number; children?: number }): StayInfo | null {
    if (!(q.checkIn && q.checkOut) && !(q.date && q.startTime && q.hours)) return null;
    const w = this.booking.resolveStay(p, { stayType: q.date ? 'DAY_USE' : 'NIGHTLY', checkIn: q.checkIn, checkOut: q.checkOut, date: q.date, startTime: q.startTime, hours: q.hours });
    return {
      arrivalDate: w.day,
      departureDate: w.stayType === 'NIGHTLY' ? w.checkOut! : w.day,
      arrivalAt: w.arrivalAt,
      nights: w.nights ?? 0,
      adults: q.adults ?? 1,
      children: q.children ?? 0,
      dayUse: w.stayType === 'DAY_USE',
    };
  }

  @Get('hotels/:slug/extras')
  @RateLimit({ name: 'availability', limit: 120, windowSec: MINUTE })
  @ApiOperation({ summary: 'Paid extras on a channel, priced for the dates and guests when given' })
  async publicExtras(@Param('slug') slug: string, @Query() q: PublicExtrasQueryDto) {
    const ref = await this.themes.hotelRef(slug);
    return this.addOns.publicExtras(ref, q, (p) => this.stayFor(p, q));
  }

  @Get('hotels/:slug/pickup-points')
  @RateLimit({ name: 'availability', limit: 120, windowSec: MINUTE })
  async points(@Param('slug') slug: string) {
    const ref = await this.themes.hotelRef(slug);
    return this.addOns.publicPickupPoints(ref);
  }

  @Get('transport-companies')
  async companies(@Query() q: HotelQueryDto) {
    if (!q.hotel) return this.extras.platformCompanies();
    const ref = await this.themes.hotelRef(q.hotel);
    return this.addOns.publicCompanies(ref);
  }

  @Get('train-routes')
  routes() {
    return this.extras.trainRoutes();
  }
}
