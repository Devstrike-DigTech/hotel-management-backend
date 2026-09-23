import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Patch, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { AuthUser } from '../../common/auth-types.js';
import { ClientIp, CurrentUser, GroupWide, RequirePermission } from '../../common/decorators/index.js';
import { RequireFeature } from '../entitlements/entitlements.decorators.js';
import {
  AccountPaymentDto,
  AccountQueryDto,
  CorporateAccountDto,
  CreateStatementDto,
  LedgerPaymentDto,
  LedgerQueryDto,
  RemindDto,
  ShareStatementDto,
  UpdateCorporateAccountDto,
  VoidStatementDto,
} from './corporate.dto.js';
import { CorporateService } from './corporate.service.js';

@ApiTags('Corporate')
@ApiBearerAuth()
@RequireFeature('promotions')
@GroupWide()
@Controller()
export class CorporateController {
  constructor(private readonly svc: CorporateService) {}

  @Get('corporate-accounts')
  @RequirePermission('corporate.view')
  list(@CurrentUser() user: AuthUser, @Query() q: AccountQueryDto) {
    return this.svc.list(user, q);
  }

  @Get('corporate-accounts/:id')
  @RequirePermission('corporate.view')
  get(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.svc.get(user, id);
  }

  @Post('corporate-accounts')
  @RequirePermission('corporate.manage')
  create(@CurrentUser() user: AuthUser, @Body() dto: CorporateAccountDto, @ClientIp() ip?: string) {
    return this.svc.create(user, dto, ip);
  }

  @Patch('corporate-accounts/:id')
  @RequirePermission('corporate.manage')
  update(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateCorporateAccountDto, @ClientIp() ip?: string) {
    return this.svc.update(user, id, dto, ip);
  }

  @Get('city-ledger/summary')
  @RequirePermission('corporate.view')
  @ApiOperation({ summary: 'Outstanding, aging buckets and credit per account' })
  summary(@CurrentUser() user: AuthUser) {
    return this.svc.summary(user);
  }

  @Get('city-ledger/charges')
  @RequirePermission('corporate.view')
  charges(@CurrentUser() user: AuthUser, @Query() q: LedgerQueryDto) {
    return this.svc.charges(user, q);
  }

  @Get('city-ledger/invoices')
  @RequirePermission('corporate.view')
  invoices(@CurrentUser() user: AuthUser, @Query() q: LedgerQueryDto) {
    return this.svc.invoices(user, q);
  }

  @Get('city-ledger/invoices/:id')
  @RequirePermission('corporate.view')
  invoice(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.svc.invoice(user, id);
  }

  @Post('city-ledger/invoices')
  @RequirePermission('corporate.manage')
  @ApiOperation({ summary: 'Issue a statement for uninvoiced charges' })
  createStatement(@CurrentUser() user: AuthUser, @Body() dto: CreateStatementDto, @ClientIp() ip?: string) {
    return this.svc.createStatement(user, dto, ip);
  }

  @Post('city-ledger/invoices/:id/payments')
  @RequirePermission('payments.take')
  pay(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body() dto: LedgerPaymentDto, @ClientIp() ip?: string) {
    return this.svc.recordInvoicePayment(user, id, dto, ip);
  }

  @Post('city-ledger/payments')
  @RequirePermission('payments.take')
  @ApiOperation({ summary: 'Record a payment on the account (allocated to the oldest statements first)' })
  payAccount(@CurrentUser() user: AuthUser, @Body() dto: AccountPaymentDto, @ClientIp() ip?: string) {
    return this.svc.recordAccountPayment(user, dto, ip);
  }

  @Get('city-ledger/payments')
  @RequirePermission('corporate.view')
  payments(@CurrentUser() user: AuthUser, @Query() q: LedgerQueryDto) {
    return this.svc.payments(user, q);
  }

  @Post('city-ledger/invoices/:id/remind')
  @HttpCode(200)
  @RequirePermission('corporate.manage')
  remind(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body() dto: RemindDto) {
    return this.svc.remind(user, id, dto.message);
  }

  @Post('city-ledger/invoices/:id/void')
  @HttpCode(200)
  @RequirePermission('corporate.manage', 'folio.void')
  void(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body() dto: VoidStatementDto, @ClientIp() ip?: string) {
    return this.svc.voidInvoice(user, id, dto.reason, ip);
  }

  @Post('city-ledger/invoices/:id/share')
  @HttpCode(200)
  @RequirePermission('corporate.view')
  share(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body() dto: ShareStatementDto, @ClientIp() ip?: string) {
    return this.svc.share(user, id, dto.expiresInHours, ip);
  }
}
