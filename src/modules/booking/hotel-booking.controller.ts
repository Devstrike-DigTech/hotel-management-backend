import { Body, Controller, Get, Param, ParseUUIDPipe, Post, Put, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { AuthUser } from '../../common/auth-types.js';
import { ClientIp, CurrentUser, Roles } from '../../common/decorators/index.js';
import { FeedQueryDto, NotificationQueryDto, RangeQueryDto, ResolveAccountDto, SavePayoutAccountDto, UpdateBookingSettingsDto } from './booking.dto.js';
import { HotelBookingService } from './hotel-booking.service.js';

@ApiTags('Online booking (hotel)')
@ApiBearerAuth()
@Controller()
export class HotelBookingController {
  constructor(private readonly svc: HotelBookingService) {}

  @Get('booking-settings')
  @Roles('OWNER', 'MANAGER', 'FRONT_DESK', 'ACCOUNTANT')
  settings(@CurrentUser() user: AuthUser) {
    return this.svc.getSettings(user);
  }

  @Put('booking-settings')
  @Roles('OWNER', 'MANAGER')
  updateSettings(@CurrentUser() user: AuthUser, @Body() dto: UpdateBookingSettingsDto, @ClientIp() ip?: string) {
    return this.svc.updateSettings(user, dto, ip);
  }

  @Get('payouts/banks')
  @Roles('OWNER', 'MANAGER', 'ACCOUNTANT')
  banks() {
    return this.svc.banks();
  }

  @Post('payouts/resolve-account')
  @Roles('OWNER')
  resolve(@Body() dto: ResolveAccountDto) {
    return this.svc.resolveAccount(dto.bankCode, dto.accountNumber);
  }

  @Get('payouts/account')
  @Roles('OWNER', 'MANAGER', 'ACCOUNTANT')
  account(@CurrentUser() user: AuthUser) {
    return this.svc.getPayoutAccount(user);
  }

  @Put('payouts/account')
  @Roles('OWNER')
  @ApiOperation({ summary: 'Save the payout bank account and create/update the Paystack subaccount' })
  saveAccount(@CurrentUser() user: AuthUser, @Body() dto: SavePayoutAccountDto, @ClientIp() ip?: string) {
    return this.svc.savePayoutAccount(user, dto, ip);
  }

  @Get('payouts/summary')
  @Roles('OWNER', 'MANAGER', 'ACCOUNTANT')
  summary(@CurrentUser() user: AuthUser, @Query() q: RangeQueryDto) {
    return this.svc.payoutSummary(user, q);
  }

  @Get('payouts/transactions')
  @Roles('OWNER', 'MANAGER', 'ACCOUNTANT')
  transactions(@CurrentUser() user: AuthUser, @Query() q: RangeQueryDto) {
    return this.svc.payoutTransactions(user, q);
  }

  @Get('payouts/commission')
  @Roles('OWNER', 'MANAGER', 'ACCOUNTANT')
  commission(@CurrentUser() user: AuthUser, @Query() q: RangeQueryDto) {
    return this.svc.commissionEntries(user, q);
  }

  @Get('online-bookings/feed')
  @Roles('OWNER', 'MANAGER', 'FRONT_DESK', 'ACCOUNTANT')
  @ApiOperation({ summary: 'Online bookings with events since a timestamp (poll every 30 s)' })
  feed(@CurrentUser() user: AuthUser, @Query() q: FeedQueryDto) {
    return this.svc.feed(user, q.since, q.limit);
  }

  @Get('reservations/:id/notifications')
  @Roles('OWNER', 'MANAGER', 'FRONT_DESK', 'ACCOUNTANT')
  reservationNotifications(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.svc.reservationNotifications(user, id);
  }

  @Get('notifications')
  @Roles('OWNER', 'MANAGER')
  notifications(@CurrentUser() user: AuthUser, @Query() q: NotificationQueryDto) {
    return this.svc.notifications(user, q);
  }

  @Get('notifications/:id/preview')
  @Roles('OWNER', 'MANAGER', 'FRONT_DESK')
  preview(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.svc.notificationPreview(user, id);
  }
}
