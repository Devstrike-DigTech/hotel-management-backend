import { Body, Controller, Delete, Get, HttpCode, Param, ParseUUIDPipe, Patch, Post, Put, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { IsBooleanString, IsOptional } from 'class-validator';
import type { AuthUser } from '../../common/auth-types.js';
import { AnyPermission, ClientIp, CurrentUser, RequirePermission } from '../../common/decorators/index.js';
import { RequireFeature } from '../entitlements/entitlements.decorators.js';
import { BookingFormService } from '../booking-form/booking-form.service.js';
import { AnswersDto } from '../booking-form/booking-form.controller.js';
import { checkPickupDetails, type PickupKindCode } from './extras.logic.js';
import { ReservationsService } from '../reservations/reservations.service.js';
import { AddOnsService } from './addons.service.js';
import {
  AssignDriverDto,
  DeskTransferDto,
  ExtraDto,
  ExtraSelectionDto,
  ExtrasQuoteDto,
  PickupPointDto,
  TransferDelayDto,
  TransferQueryDto,
  TransferStatusDto,
  TransportCompanyDto,
  UpdateExtraDto,
  UpdatePickupPointDto,
  UpdateTransferDto,
} from './extras.dto.js';
import { ExtrasService } from './extras.service.js';
import { TransfersService } from './transfers.service.js';

export class ActiveQueryDto {
  @IsOptional() @IsBooleanString() active?: string;
}

const activeOf = (q: ActiveQueryDto) => (q.active === undefined ? undefined : q.active === 'true');

@ApiTags('Extras and pickups')
@ApiBearerAuth()
@RequireFeature('paid_extras')
@Controller()
export class ExtrasController {
  constructor(
    private readonly extras: ExtrasService,
    private readonly addOns: AddOnsService,
  ) {}

  @Get('extras') @AnyPermission('extras.manage', 'reservations.create', 'reservations.edit')
  list(@CurrentUser() u: AuthUser, @Query() q: ActiveQueryDto) {
    return this.extras.listExtras(u, activeOf(q));
  }

  @Post('extras') @RequirePermission('extras.manage')
  create(@CurrentUser() u: AuthUser, @Body() dto: ExtraDto, @ClientIp() ip?: string) {
    return this.extras.createExtra(u, dto, ip);
  }

  @Patch('extras/:id') @RequirePermission('extras.manage')
  update(@CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateExtraDto, @ClientIp() ip?: string) {
    return this.extras.updateExtra(u, id, dto, ip);
  }

  @Delete('extras/:id') @RequirePermission('extras.manage')
  remove(@CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string, @ClientIp() ip?: string) {
    return this.extras.removeExtra(u, id, ip);
  }

  @Post('extras/quote') @AnyPermission('extras.manage', 'reservations.create', 'reservations.edit') @HttpCode(200)
  quote(@CurrentUser() u: AuthUser, @Body() dto: ExtrasQuoteDto) {
    return this.addOns.quoteForDesk(u, dto);
  }

  @Get('pickup-points') @AnyPermission('extras.manage', 'reservations.create', 'transfers.view')
  points(@CurrentUser() u: AuthUser, @Query() q: ActiveQueryDto) {
    return this.extras.listPoints(u, activeOf(q));
  }

  @Post('pickup-points') @RequirePermission('extras.manage')
  createPoint(@CurrentUser() u: AuthUser, @Body() dto: PickupPointDto, @ClientIp() ip?: string) {
    return this.extras.createPoint(u, dto, ip);
  }

  @Patch('pickup-points/:id') @RequirePermission('extras.manage')
  updatePoint(@CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdatePickupPointDto, @ClientIp() ip?: string) {
    return this.extras.updatePoint(u, id, dto, ip);
  }

  @Delete('pickup-points/:id') @RequirePermission('extras.manage')
  removePoint(@CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string, @ClientIp() ip?: string) {
    return this.extras.removePoint(u, id, ip);
  }

  @Get('transport-companies') @AnyPermission('extras.manage', 'reservations.create', 'transfers.view')
  companies(@CurrentUser() u: AuthUser) {
    return this.extras.companies(u);
  }

  @Post('transport-companies') @RequirePermission('extras.manage')
  addCompany(@CurrentUser() u: AuthUser, @Body() dto: TransportCompanyDto, @ClientIp() ip?: string) {
    return this.extras.addCompany(u, dto, ip);
  }

  @Delete('transport-companies/:id') @RequirePermission('extras.manage')
  removeCompany(@CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string, @ClientIp() ip?: string) {
    return this.extras.removeCompany(u, id, ip);
  }

  @Get('train-routes') @AnyPermission('extras.manage', 'reservations.create', 'transfers.view')
  routes() {
    return this.extras.trainRoutes();
  }
}

@ApiTags('Transfers')
@ApiBearerAuth()
@RequireFeature('paid_extras')
@Controller('transfers')
export class TransfersController {
  constructor(private readonly transfers: TransfersService) {}

  @Get() @RequirePermission('transfers.view')
  list(@CurrentUser() u: AuthUser, @Query() q: TransferQueryDto) {
    return this.transfers.list(u, q);
  }

  @Get('today') @RequirePermission('transfers.view')
  today(@CurrentUser() u: AuthUser) {
    return this.transfers.today(u);
  }

  @Get(':id') @RequirePermission('transfers.view')
  get(@CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.transfers.get(u, id);
  }

  @Patch(':id') @RequirePermission('transfers.manage')
  update(@CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateTransferDto, @ClientIp() ip?: string) {
    return this.transfers.update(u, id, dto, ip);
  }

  @Post(':id/confirm') @RequirePermission('transfers.manage') @HttpCode(200)
  confirm(@CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string, @ClientIp() ip?: string) {
    return this.transfers.confirm(u, id, ip);
  }

  @Post(':id/assign') @RequirePermission('transfers.manage') @HttpCode(200)
  assign(@CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body() dto: AssignDriverDto, @ClientIp() ip?: string) {
    return this.transfers.assign(u, id, dto, ip);
  }

  @Post(':id/status') @RequirePermission('transfers.manage') @HttpCode(200)
  status(@CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body() dto: TransferStatusDto, @ClientIp() ip?: string) {
    return this.transfers.setStatus(u, id, dto, ip);
  }

  @Post(':id/delay') @RequirePermission('transfers.manage') @HttpCode(200)
  delay(@CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body() dto: TransferDelayDto, @ClientIp() ip?: string) {
    return this.transfers.delay(u, id, dto, ip);
  }
}

@ApiTags('Reservations')
@ApiBearerAuth()
@Controller('reservations/:id')
export class ReservationAddOnsController {
  constructor(
    private readonly addOns: AddOnsService,
    private readonly transfers: TransfersService,
    private readonly forms: BookingFormService,
    private readonly reservations: ReservationsService,
    private readonly extras: ExtrasService,
  ) {}

  @Get('extras') @RequirePermission('reservations.view')
  list(@CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.addOns.listForReservation(u, id);
  }

  @Post('extras') @RequirePermission('reservations.edit') @RequireFeature('paid_extras')
  addExtra(@CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body() dto: ExtraSelectionDto, @ClientIp() ip?: string) {
    return this.addOns.addExtra(u, id, dto, ip);
  }

  @Delete('extras/:lineId') @RequirePermission('reservations.edit')
  removeExtra(@CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Param('lineId', ParseUUIDPipe) lineId: string, @ClientIp() ip?: string) {
    return this.addOns.removeExtra(u, id, lineId, ip);
  }

  @Post('transfers') @RequirePermission('reservations.edit') @RequireFeature('paid_extras')
  async addTransfer(@CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body() dto: DeskTransferDto, @ClientIp() ip?: string) {
    const transferId = await this.addOns.addTransfer(
      u,
      id,
      dto,
      async (tx, kind, details) => {
        const companyList = await this.extras.companiesTx(tx, u.tenantId);
        const routeList = await this.extras.trainRoutes();
        const r = checkPickupDetails(kind as PickupKindCode, details, 'details', { transportCompanyIds: new Set(companyList.map((c) => c.id)), trainRouteIds: new Set(routeList.map((x) => x.id)) });
        if (typeof r.value.transportCompanyId === 'string') r.value.transportCompanyName = companyList.find((c) => c.id === r.value.transportCompanyId)?.name ?? null;
        if (typeof r.value.trainRouteId === 'string') r.value.trainRouteName = routeList.find((x) => x.id === r.value.trainRouteId)?.name ?? null;
        return r;
      },
      ip,
    );
    return this.transfers.get(u, transferId);
  }

  @Delete('transfers/:transferId') @RequirePermission('reservations.edit')
  removeTransfer(@CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Param('transferId', ParseUUIDPipe) transferId: string, @ClientIp() ip?: string) {
    return this.addOns.removeTransfer(u, id, transferId, ip);
  }

  @Put('form-answers') @RequirePermission('reservations.edit')
  async answers(@CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body() dto: AnswersDto, @ClientIp() ip?: string) {
    await this.forms.updateAnswers(u, id, dto.answers, ip);
    return this.reservations.get(u, id);
  }
}
