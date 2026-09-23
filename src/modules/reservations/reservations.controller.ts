import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Patch, Post, Put, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { AuthUser } from '../../common/auth-types.js';
import { ClientIp, CurrentUser, RequirePermission } from '../../common/decorators/index.js';
import { RequireFeature } from '../entitlements/entitlements.decorators.js';
import { LedgerService } from '../folios/ledger.service.js';
import { AvailabilityService } from './availability.service.js';
import {
  AvailabilityQueryDto,
  CancelDto,
  CheckInDto,
  CheckOutDto,
  ConvertToNightlyDto,
  CreateReservationDto,
  MoveRoomDto,
  NoShowDto,
  PutRegistrationDto,
  ReservationQueryDto,
  RoomsAvailabilityQueryDto,
  TapeChartQueryDto,
  UpdateReservationDto,
} from './reservations.dto.js';
import { ReservationsService } from './reservations.service.js';

@ApiTags('Reservations')
@ApiBearerAuth()
@RequireFeature('reservations')
@Controller('reservations')
export class ReservationsController {
  constructor(
    private readonly svc: ReservationsService,
    private readonly ledger: LedgerService,
  ) {}

  @Get()
  @RequirePermission('reservations.view')
  list(@CurrentUser() user: AuthUser, @Query() q: ReservationQueryDto) {
    return this.svc.list(user, q);
  }

  @Post()
  @RequirePermission('reservations.create')
  @ApiOperation({ summary: 'Book a stay (409 ROOM_UNAVAILABLE when it does not fit)' })
  create(@CurrentUser() user: AuthUser, @Body() dto: CreateReservationDto, @ClientIp() ip?: string) {
    return this.svc.create(user, dto, ip);
  }

  @Get(':id')
  @RequirePermission('reservations.view')
  get(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.svc.get(user, id);
  }

  @Get(':id/folio')
  @RequirePermission('reservations.view')
  folio(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.ledger.getByReservation(user, id);
  }

  @Patch(':id')
  @RequirePermission('reservations.edit')
  @ApiOperation({ summary: 'Move, extend, shorten or edit a stay (re-validates availability)' })
  update(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateReservationDto, @ClientIp() ip?: string) {
    return this.svc.update(user, id, dto, ip);
  }

  @Post(':id/confirm')
  @HttpCode(200)
  @RequirePermission('reservations.edit')
  confirm(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string, @ClientIp() ip?: string) {
    return this.svc.confirm(user, id, ip);
  }

  @Post(':id/check-in')
  @HttpCode(200)
  @RequirePermission('frontdesk.checkin')
  @RequireFeature('reservations', 'front_desk')
  @ApiOperation({ summary: 'Check in: clean room, register card, first night charge, optional deposit' })
  checkIn(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body() dto: CheckInDto, @ClientIp() ip?: string) {
    return this.svc.checkIn(user, id, dto, ip);
  }

  @Put(':id/registration')
  @RequirePermission('frontdesk.checkin')
  registration(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body() dto: PutRegistrationDto, @ClientIp() ip?: string) {
    return this.svc.putRegistration(user, id, dto, ip);
  }

  @Post(':id/check-out')
  @HttpCode(200)
  @RequirePermission('frontdesk.checkout')
  @RequireFeature('reservations', 'front_desk')
  @ApiOperation({ summary: 'Check out: balance must be zero (or manager city-ledger override); issues the final invoice' })
  checkOut(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body() dto: CheckOutDto, @ClientIp() ip?: string) {
    return this.svc.checkOut(user, id, dto, ip);
  }

  @Post(':id/move-room')
  @HttpCode(200)
  @RequirePermission('reservations.edit')
  move(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body() dto: MoveRoomDto, @ClientIp() ip?: string) {
    return this.svc.moveRoom(user, id, dto.roomId, dto.reason, ip);
  }

  @Post(':id/convert-to-nightly')
  @HttpCode(200)
  @RequirePermission('frontdesk.checkin')
  convert(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body() dto: ConvertToNightlyDto, @ClientIp() ip?: string) {
    return this.svc.convertToNightly(user, id, dto.departureDate, ip);
  }

  @Post(':id/cancel')
  @HttpCode(200)
  @RequirePermission('reservations.cancel')
  cancel(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body() dto: CancelDto, @ClientIp() ip?: string) {
    return this.svc.cancel(user, id, dto, ip);
  }

  @Post(':id/no-show')
  @HttpCode(200)
  @RequirePermission('reservations.cancel')
  noShow(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body() dto: NoShowDto, @ClientIp() ip?: string) {
    return this.svc.noShow(user, id, dto, ip);
  }
}

@ApiTags('Reservations')
@ApiBearerAuth()
@RequireFeature('reservations')
@RequirePermission('reservations.view')
@Controller()
export class AvailabilityController {
  constructor(private readonly availability: AvailabilityService) {}

  @Get('availability')
  @ApiOperation({ summary: 'Per room type, per night availability for a date range (to inclusive)' })
  grid(@CurrentUser() user: AuthUser, @Query() q: AvailabilityQueryDto) {
    return this.availability.grid(user, q.from, q.to, q.roomTypeId);
  }

  @Get('availability/rooms')
  @ApiOperation({ summary: 'Rooms of a type with whether each is free for a window (room picker)' })
  rooms(@CurrentUser() user: AuthUser, @Query() q: RoomsAvailabilityQueryDto) {
    return this.availability.roomsFor(user, q);
  }

  @Get('tape-chart')
  @ApiOperation({ summary: 'Rooms and stays for the reservations calendar' })
  tape(@CurrentUser() user: AuthUser, @Query() q: TapeChartQueryDto) {
    return this.availability.tapeChart(user, q.from, q.to);
  }
}
