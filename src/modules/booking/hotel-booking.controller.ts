import { Body, Controller, Get, Param, ParseUUIDPipe, Post, Put, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { AuthUser } from '../../common/auth-types.js';
import { ClientIp, CurrentUser, RequirePermission } from '../../common/decorators/index.js';
import { FeedQueryDto, NotificationQueryDto, RangeQueryDto, ResolveAccountDto, SavePayoutAccountDto, UpdateBookingSettingsDto } from './booking.dto.js';
import { HotelBookingService } from './hotel-booking.service.js';

@ApiTags('Online booking (hotel)')
@ApiBearerAuth()
@Controller()
export class HotelBookingController {
  constructor(private readonly svc: HotelBookingService) {}

  @Get('booking-settings')
  @RequirePermission('reservations.view')
  settings(@CurrentUser() user: AuthUser) {
    return this.svc.getSettings(user);
  }

  @Put('booking-settings')
  @RequirePermission('settings.manage')
  updateSettings(@CurrentUser() user: AuthUser, @Body() dto: UpdateBookingSettingsDto, @ClientIp() ip?: string) {
    return this.svc.updateSettings(user, dto, ip);
  }

  @Get('payouts/banks')
  @RequirePermission('reports.financial')
  banks() {
    return this.svc.banks();
  }

  @Post('payouts/resolve-account')
  @RequirePermission('payouts.manage')
  resolve(@Body() dto: ResolveAccountDto) {
    return this.svc.resolveAccount(dto.bankCode, dto.accountNumber);
  }

  @Get('payouts/account')
  @RequirePermission('reports.financial')
  account(@CurrentUser() user: AuthUser) {
    return this.svc.getPayoutAccount(user);
  }

  @Put('payouts/account')
  @RequirePermission('payouts.manage')
  @ApiOperation({ summary: 'Save the payout bank account and create/update the Paystack subaccount' })
  saveAccount(@CurrentUser() user: AuthUser, @Body() dto: SavePayoutAccountDto, @ClientIp() ip?: string) {
    return this.svc.savePayoutAccount(user, dto, ip);
  }

  @Get('payouts/summary')
  @RequirePermission('reports.financial')
  summary(@CurrentUser() user: AuthUser, @Query() q: RangeQueryDto) {
    return this.svc.payoutSummary(user, q);
  }

  @Get('payouts/transactions')
  @RequirePermission('reports.financial')
  transactions(@CurrentUser() user: AuthUser, @Query() q: RangeQueryDto) {
    return this.svc.payoutTransactions(user, q);
  }

  @Get('payouts/commission')
  @RequirePermission('reports.financial')
  commission(@CurrentUser() user: AuthUser, @Query() q: RangeQueryDto) {
    return this.svc.commissionEntries(user, q);
  }

  @Get('online-bookings/feed')
  @RequirePermission('reservations.view')
  @ApiOperation({ summary: 'Online bookings with events since a timestamp (poll every 30 s)' })
  feed(@CurrentUser() user: AuthUser, @Query() q: FeedQueryDto) {
    return this.svc.feed(user, q.since, q.limit);
  }

  @Get('reservations/:id/notifications')
  @RequirePermission('reservations.view')
  reservationNotifications(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.svc.reservationNotifications(user, id);
  }

  @Get('notifications')
  @RequirePermission('settings.manage')
  notifications(@CurrentUser() user: AuthUser, @Query() q: NotificationQueryDto) {
    return this.svc.notifications(user, q);
  }

  @Get('notifications/:id/preview')
  @RequirePermission('reservations.create')
  preview(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.svc.notificationPreview(user, id);
  }
}
