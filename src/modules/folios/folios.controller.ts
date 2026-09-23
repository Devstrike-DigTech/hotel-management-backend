import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Post, Put, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { AuthUser } from '../../common/auth-types.js';
import { ClientIp, CurrentUser, Roles } from '../../common/decorators/index.js';
import { RequireFeature } from '../entitlements/entitlements.decorators.js';
import { DocumentsService } from '../invoices/documents.service.js';
import {
  AddChargeDto,
  AddDiscountDto,
  AddPaymentDto,
  AddRefundDto,
  CreateFolioDto,
  FolioQueryDto,
  ProformaDto,
  UpdateTaxSettingsDto,
  VoidEntryDto,
} from './folios.dto.js';
import { LedgerService } from './ledger.service.js';
import { TaxSettingsService } from './tax-settings.service.js';

@ApiTags('Folios')
@ApiBearerAuth()
@RequireFeature('front_desk')
@Controller('folios')
export class FoliosController {
  constructor(
    private readonly ledger: LedgerService,
    private readonly docs: DocumentsService,
  ) {}

  @Get()
  @Roles('OWNER', 'MANAGER', 'FRONT_DESK', 'ACCOUNTANT')
  list(@CurrentUser() user: AuthUser, @Query() q: FolioQueryDto) {
    return this.ledger.list(user, q);
  }

  @Post()
  @Roles('OWNER', 'MANAGER', 'FRONT_DESK')
  @ApiOperation({ summary: 'Open a standalone walk-in folio (restaurant, pool pass, ...)' })
  create(@CurrentUser() user: AuthUser, @Body() dto: CreateFolioDto, @ClientIp() ip?: string) {
    return this.ledger.createWalkIn(user, dto, ip);
  }

  @Get(':id')
  @Roles('OWNER', 'MANAGER', 'FRONT_DESK', 'ACCOUNTANT')
  get(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.ledger.get(user, id);
  }

  @Post(':id/charges')
  @HttpCode(200)
  @Roles('OWNER', 'MANAGER', 'FRONT_DESK')
  charge(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body() dto: AddChargeDto, @ClientIp() ip?: string) {
    return this.ledger.addCharge(user, id, dto, ip);
  }

  @Post(':id/discounts')
  @HttpCode(200)
  @Roles('OWNER', 'MANAGER', 'FRONT_DESK')
  @ApiOperation({ summary: 'Discount; above the threshold needs a manager PIN (revenue_guard_full) or is flagged' })
  discount(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body() dto: AddDiscountDto, @ClientIp() ip?: string) {
    return this.ledger.addDiscount(user, id, dto, ip);
  }

  @Post(':id/payments')
  @Roles('OWNER', 'MANAGER', 'FRONT_DESK')
  @ApiOperation({ summary: 'Record a payment; cash, transfer and POS need an open shift (409 SHIFT_REQUIRED)' })
  payment(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body() dto: AddPaymentDto, @ClientIp() ip?: string) {
    return this.ledger.addPayment(user, id, dto, ip);
  }

  @Post(':id/refunds')
  @HttpCode(200)
  @Roles('OWNER', 'MANAGER')
  refund(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body() dto: AddRefundDto, @ClientIp() ip?: string) {
    return this.ledger.addRefund(user, id, dto, ip);
  }

  @Post(':id/entries/:entryId/void')
  @HttpCode(200)
  @Roles('OWNER', 'MANAGER')
  @ApiOperation({ summary: 'Void an entry (and its tax lines) with a reason' })
  void(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('entryId', ParseUUIDPipe) entryId: string,
    @Body() dto: VoidEntryDto,
    @ClientIp() ip?: string,
  ) {
    return this.ledger.voidEntry(user, id, entryId, dto.reason, ip);
  }

  @Post(':id/close')
  @HttpCode(200)
  @Roles('OWNER', 'MANAGER', 'FRONT_DESK')
  close(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string, @ClientIp() ip?: string) {
    return this.ledger.closeWalkIn(user, id, ip);
  }

  @Post(':id/invoices')
  @Roles('OWNER', 'MANAGER', 'FRONT_DESK', 'ACCOUNTANT')
  @RequireFeature('invoicing')
  proforma(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body() _dto: ProformaDto, @ClientIp() ip?: string) {
    return this.docs.createProforma(user, id, ip);
  }
}

@ApiTags('Folios')
@ApiBearerAuth()
@RequireFeature('front_desk')
@Controller('tax-settings')
export class TaxSettingsController {
  constructor(private readonly taxes: TaxSettingsService) {}

  @Get()
  @Roles('OWNER', 'MANAGER', 'FRONT_DESK', 'ACCOUNTANT')
  get(@CurrentUser() user: AuthUser) {
    return this.taxes.get(user);
  }

  @Put()
  @Roles('OWNER', 'MANAGER')
  update(@CurrentUser() user: AuthUser, @Body() dto: UpdateTaxSettingsDto, @ClientIp() ip?: string) {
    return this.taxes.update(user, dto, ip);
  }
}
