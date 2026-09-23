import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import type { AuthUser } from '../../common/auth-types.js';
import { ClientIp, CurrentUser, Public, Roles } from '../../common/decorators/index.js';
import { RequireFeature } from '../entitlements/entitlements.decorators.js';
import { InvoiceQueryDto, ReceiptQueryDto, ShareDto } from '../folios/folios.dto.js';
import { DocumentsService } from './documents.service.js';

@ApiTags('Invoices')
@ApiBearerAuth()
@RequireFeature('invoicing')
@Roles('OWNER', 'MANAGER', 'FRONT_DESK', 'ACCOUNTANT')
@Controller()
export class InvoicesController {
  constructor(private readonly docs: DocumentsService) {}

  @Get('invoices')
  listInvoices(@CurrentUser() user: AuthUser, @Query() q: InvoiceQueryDto) {
    return this.docs.listInvoices(user, q);
  }

  @Get('invoices/:id')
  getInvoice(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.docs.getInvoice(user, id);
  }

  @Post('invoices/:id/share')
  @HttpCode(200)
  shareInvoice(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body() dto: ShareDto, @ClientIp() ip?: string) {
    return this.docs.share(user, 'INVOICE', id, dto.expiresInHours, ip);
  }

  @Get('receipts')
  listReceipts(@CurrentUser() user: AuthUser, @Query() q: ReceiptQueryDto) {
    return this.docs.listReceipts(user, q);
  }

  @Get('receipts/:id')
  getReceipt(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.docs.getReceipt(user, id);
  }

  @Post('receipts/:id/share')
  @HttpCode(200)
  shareReceipt(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body() dto: ShareDto, @ClientIp() ip?: string) {
    return this.docs.share(user, 'RECEIPT', id, dto.expiresInHours, ip);
  }
}

@ApiTags('Public')
@Public()
@Controller('public/documents')
export class PublicDocumentsController {
  constructor(private readonly docs: DocumentsService) {}

  /** A guest opens an invoice or receipt from a signed share link. */
  @Get(':token')
  get(@Param('token') token: string) {
    return this.docs.publicDocument(token);
  }
}
