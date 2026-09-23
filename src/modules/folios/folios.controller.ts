import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Post, Put, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { AuthUser } from '../../common/auth-types.js';
import { ClientIp, CurrentUser, RequirePermission } from '../../common/decorators/index.js';
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
  @RequirePermission('folio.view')
  list(@CurrentUser() user: AuthUser, @Query() q: FolioQueryDto) {
    return this.ledger.list(user, q);
  }

  @Post()
  @RequirePermission('folio.charge')
  @ApiOperation({ summary: 'Open a standalone walk-in folio (restaurant, pool pass, ...)' })
  create(@CurrentUser() user: AuthUser, @Body() dto: CreateFolioDto, @ClientIp() ip?: string) {
    return this.ledger.createWalkIn(user, dto, ip);
  }

  @Get(':id')
  @RequirePermission('folio.view')
  get(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.ledger.get(user, id);
  }

  @Post(':id/charges')
  @HttpCode(200)
  @RequirePermission('folio.charge')
  charge(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body() dto: AddChargeDto, @ClientIp() ip?: string) {
    return this.ledger.addCharge(user, id, dto, ip);
  }

  @Post(':id/discounts')
  @HttpCode(200)
  @RequirePermission('folio.discount')
  @ApiOperation({ summary: 'Discount; above the threshold needs a manager PIN (revenue_guard_full) or is flagged' })
  discount(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body() dto: AddDiscountDto, @ClientIp() ip?: string) {
    return this.ledger.addDiscount(user, id, dto, ip);
  }

  @Post(':id/payments')
  @RequirePermission('payments.take')
  @ApiOperation({ summary: 'Record a payment; cash, transfer and POS need an open shift (409 SHIFT_REQUIRED)' })
  payment(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body() dto: AddPaymentDto, @ClientIp() ip?: string) {
    return this.ledger.addPayment(user, id, dto, ip);
  }

  @Post(':id/refunds')
  @HttpCode(200)
  @RequirePermission('folio.refund')
  refund(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body() dto: AddRefundDto, @ClientIp() ip?: string) {
    return this.ledger.addRefund(user, id, dto, ip);
  }

  @Post(':id/entries/:entryId/void')
  @HttpCode(200)
  @RequirePermission('folio.void')
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
  @RequirePermission('folio.charge')
  close(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string, @ClientIp() ip?: string) {
    return this.ledger.closeWalkIn(user, id, ip);
  }

  @Post(':id/invoices')
  @RequirePermission('folio.view')
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
  @RequirePermission('folio.view')
  get(@CurrentUser() user: AuthUser) {
    return this.taxes.get(user);
  }

  @Put()
  @RequirePermission('settings.manage')
  update(@CurrentUser() user: AuthUser, @Body() dto: UpdateTaxSettingsDto, @ClientIp() ip?: string) {
    return this.taxes.update(user, dto, ip);
  }
}
