import { HttpStatus, Injectable, Logger } from '@nestjs/common';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { AppException, ErrorCode } from '../../common/errors/app-exception.js';
import { AppConfigService } from '../../config/app-config.service.js';

export interface InitializeParams {
  email: string;
  amountKobo: number;
  reference: string;
  callbackUrl: string;
  metadata: Record<string, unknown>;
}

/**
 * Minimal Paystack REST client (https://paystack.com/docs/api/).
 * Only the calls M1 needs; uses global fetch.
 */
@Injectable()
export class PaystackClient {
  private readonly logger = new Logger(PaystackClient.name);

  constructor(private readonly config: AppConfigService) {}

  get enabled(): boolean {
    return this.config.paystackEnabled;
  }

  async initializeTransaction(
    p: InitializeParams,
  ): Promise<{ authorizationUrl: string; accessCode: string }> {
    const key = this.config.get('PAYSTACK_SECRET_KEY');
    if (!key) throw new Error('Paystack is not configured');
    let res: Response;
    try {
      res = await fetch(
        `${this.config.get('PAYSTACK_BASE_URL')}/transaction/initialize`,
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${key}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            email: p.email,
            amount: p.amountKobo,
            currency: 'NGN',
            reference: p.reference,
            callback_url: p.callbackUrl,
            metadata: p.metadata,
          }),
          signal: AbortSignal.timeout(15_000),
        },
      );
    } catch (err) {
      this.logger.error(`Paystack initialize failed: ${String(err)}`);
      throw providerError('Could not reach the payment provider');
    }
    const body = (await res.json().catch(() => null)) as {
      status?: boolean;
      message?: string;
      data?: { authorization_url?: string; access_code?: string };
    } | null;
    if (!res.ok || !body?.status || !body.data?.authorization_url) {
      this.logger.error(
        `Paystack initialize rejected (${res.status}): ${body?.message ?? 'no body'}`,
      );
      throw providerError(body?.message ?? 'The payment provider rejected the request');
    }
    return {
      authorizationUrl: body.data.authorization_url,
      accessCode: body.data.access_code ?? '',
    };
  }

  /**
   * Verifies `x-paystack-signature`: HMAC-SHA512 of the raw request body,
   * keyed with the secret key, hex encoded. Constant-time comparison.
   */
  verifySignature(rawBody: Buffer | undefined, signature: string | undefined): boolean {
    const key = this.config.get('PAYSTACK_SECRET_KEY');
    if (!key || !rawBody || !signature) return false;
    const expected = createHmac('sha512', key).update(rawBody).digest('hex');
    const a = Buffer.from(expected, 'utf8');
    const b = Buffer.from(signature.trim().toLowerCase(), 'utf8');
    return a.length === b.length && timingSafeEqual(a, b);
  }
}

function providerError(message: string): AppException {
  return new AppException(
    HttpStatus.BAD_GATEWAY,
    ErrorCode.PAYMENT_PROVIDER_ERROR,
    message,
  );
}
