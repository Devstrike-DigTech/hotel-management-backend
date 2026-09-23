import {
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  Post,
  Req,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { AppRequest, AuthUser } from '../../common/auth-types.js';
import { AllowWhenReadOnly, ClientIp, CurrentUser, GroupWide, Public, RequirePermission } from '../../common/decorators/index.js';
import { CheckoutDto, ConfirmDto } from './billing.dto.js';
import { BillingService } from './billing.service.js';
import { PaystackWebhookService } from './paystack-webhook.service.js';

@ApiTags('Billing')
@ApiBearerAuth()
@GroupWide()
@Controller('billing')
export class BillingController {
  constructor(
    private readonly billing: BillingService,
    private readonly webhooks: PaystackWebhookService,
  ) {}

  @Get('subscription')
  subscription(@CurrentUser() user: AuthUser) {
    return this.billing.subscription(user);
  }

  @Get('invoices')
  @RequirePermission('billing.manage')
  invoices(@CurrentUser() user: AuthUser) {
    return this.billing.invoices(user);
  }

  @Post('checkout')
  @HttpCode(200)
  @AllowWhenReadOnly()
  @RequirePermission('billing.manage')
  @ApiOperation({
    summary: 'Start a payment for a plan; returns the URL to send the user to',
  })
  checkout(
    @CurrentUser() user: AuthUser,
    @Body() dto: CheckoutDto,
    @ClientIp() ip?: string,
  ) {
    return this.billing.checkout(user, dto, ip);
  }

  @Post('dev/confirm')
  @HttpCode(200)
  @AllowWhenReadOnly()
  @RequirePermission('billing.manage')
  @ApiOperation({
    summary: 'Development only: complete a mock checkout (404 in production)',
  })
  devConfirm(
    @CurrentUser() user: AuthUser,
    @Body() dto: ConfirmDto,
    @ClientIp() ip?: string,
  ) {
    return this.billing.devConfirm(user, dto.reference, ip);
  }

  @Post('webhooks/paystack')
  @Public()
  @HttpCode(200)
  @ApiOperation({
    summary: 'Paystack webhook (x-paystack-signature = HMAC-SHA512 of raw body)',
  })
  webhook(
    @Req() req: AppRequest,
    @Headers('x-paystack-signature') signature?: string,
  ) {
    return this.webhooks.handle(req.rawBody, signature);
  }
}

