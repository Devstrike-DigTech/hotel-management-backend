import { Body, Controller, Delete, Get, Headers, HttpCode, Param, ParseUUIDPipe, Patch, Post, Put, Query, Req, Res } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import type { AppRequest, AuthUser } from '../../common/auth-types.js';
import { AnyPermission, ClientIp, CurrentUser, Public, RequirePermission } from '../../common/decorators/index.js';
import { AppException } from '../../common/errors/app-exception.js';
import { RequireFeature } from '../entitlements/entitlements.decorators.js';
import { BookingsQueryDto, CostQueryDto, CreateConnectionDto, DevBookingDto, FeedDto, LogsQueryDto, MappingsDto, SyncDto, UpdateConnectionDto } from './channels.dto.js';
import { ChannelsService } from './channels.service.js';
import { OtaBookingsService } from './ota-bookings.service.js';

@ApiTags('Channels')
@ApiBearerAuth()
@RequireFeature('channel_manager')
@Controller('channels')
export class ChannelsController {
  constructor(
    private readonly channels: ChannelsService,
    private readonly ota: OtaBookingsService,
  ) {}

  @Get('summary') @RequirePermission('channels.view')
  summary(@CurrentUser() u: AuthUser) { return this.channels.summary(u); }

  @Get('connections') @RequirePermission('channels.view')
  list(@CurrentUser() u: AuthUser) { return this.channels.list(u); }

  @Post('connections') @RequirePermission('channels.manage')
  create(@CurrentUser() u: AuthUser, @Body() dto: CreateConnectionDto, @ClientIp() ip?: string) { return this.channels.create(u, dto, ip); }

  @Get('connections/:id') @RequirePermission('channels.view')
  get(@CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string) { return this.channels.get(u, id); }

  @Patch('connections/:id') @RequirePermission('channels.manage')
  update(@CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateConnectionDto, @ClientIp() ip?: string) { return this.channels.update(u, id, dto, ip); }

  @Delete('connections/:id') @RequirePermission('channels.manage')
  remove(@CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string, @ClientIp() ip?: string) { return this.channels.remove(u, id, ip); }

  @Post('connections/:id/sync') @RequirePermission('channels.manage') @HttpCode(200)
  @ApiOperation({ summary: 'iCal: import now; Channex: push pending ARI (full = whole horizon) and pull unacknowledged bookings' })
  sync(@CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body() dto: SyncDto) { return this.ota.sync(u, id, dto.full); }

  @Get('connections/:id/ical/exports') @RequirePermission('channels.view')
  exports(@CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string) { return this.channels.exports(u, id); }

  @Post('connections/:id/ical/rotate') @RequirePermission('channels.manage') @HttpCode(200)
  rotate(@CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string, @ClientIp() ip?: string) { return this.channels.rotate(u, id, ip); }

  @Get('connections/:id/ical/feeds') @RequirePermission('channels.view')
  feeds(@CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string) { return this.channels.feeds(u, id); }

  @Post('connections/:id/ical/feeds') @RequirePermission('channels.manage')
  addFeed(@CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body() dto: FeedDto, @ClientIp() ip?: string) { return this.channels.addFeed(u, id, dto, ip); }

  @Delete('connections/:id/ical/feeds/:feedId') @RequirePermission('channels.manage')
  removeFeed(@CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Param('feedId', ParseUUIDPipe) feedId: string, @ClientIp() ip?: string) { return this.channels.removeFeed(u, id, feedId, ip); }

  @Get('connections/:id/remote') @RequirePermission('channels.view')
  remote(@CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string) { return this.channels.remote(u, id); }

  @Get('connections/:id/mappings') @RequirePermission('channels.view')
  mappings(@CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string) { return this.channels.mappings(u, id); }

  @Put('connections/:id/mappings') @RequirePermission('channels.manage')
  setMappings(@CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body() dto: MappingsDto, @ClientIp() ip?: string) { return this.channels.setMappings(u, id, dto.mappings, ip); }

  @Get('bookings') @RequirePermission('channels.view')
  bookings(@CurrentUser() u: AuthUser, @Query() q: BookingsQueryDto) { return this.channels.bookings(u, q); }

  @Get('logs') @RequirePermission('channels.view')
  logs(@CurrentUser() u: AuthUser, @Query() q: LogsQueryDto) { return this.channels.logs(u, q); }

  @Get('cost') @AnyPermission('channels.view', 'reports.financial')
  cost(@CurrentUser() u: AuthUser, @Query() q: CostQueryDto) { return this.channels.cost(u, q.month); }

  @Post('dev/channex/bookings') @RequirePermission('channels.manage') @HttpCode(200)
  @ApiOperation({ summary: 'Development only: a mock Channex booking delivered through the signed webhook' })
  devBooking(@CurrentUser() u: AuthUser, @Body() dto: DevBookingDto) {
    return this.ota.devBooking(u, dto, async (raw, signature) => {
      if (!this.ota.verifySignature(Buffer.from(raw), signature)) return { status: 401, body: { code: 'INVALID_SIGNATURE' } };
      return { status: 200, body: await this.ota.webhook(JSON.parse(raw)) };
    });
  }
}

@ApiTags('Channels')
@Controller()
export class ChannelsPublicController {
  constructor(
    private readonly channels: ChannelsService,
    private readonly ota: OtaBookingsService,
  ) {}

  @Get('public/ical/:token')
  @Public()
  @ApiOperation({ summary: 'iCal export feed of blocked nights (signed URL)' })
  async ical(@Param('token') token: string, @Res() res: Response) {
    const body = await this.channels.icalFeed(token);
    res.setHeader('Content-Type', 'text/calendar; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    res.send(body);
  }

  @Post('webhooks/channex')
  @Public()
  @HttpCode(200)
  @ApiOperation({ summary: 'Channex booking push (X-Channex-Signature = hex HMAC-SHA256 of the raw body)' })
  channex(@Req() req: AppRequest, @Headers('x-channex-signature') signature: string | undefined, @Body() body: { event?: string; property_id?: string; payload?: { booking_id?: string; revision_id?: string } }) {
    if (!this.ota.verifySignature(req.rawBody, signature)) throw new AppException(401, 'INVALID_SIGNATURE', 'Invalid webhook signature');
    return this.ota.webhook(body);
  }
}
