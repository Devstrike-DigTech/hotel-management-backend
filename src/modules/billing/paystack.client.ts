import { HttpStatus, Injectable, Logger } from '@nestjs/common';
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { AppException, ErrorCode } from '../../common/errors/app-exception.js';
import { AppConfigService } from '../../config/app-config.service.js';
import { MOCK_BANKS, mockAccountName } from './paystack.mock.js';

export interface InitializeParams {
  email: string;
  amountKobo: number;
  reference: string;
  callbackUrl: string;
  metadata: Record<string, unknown>;
  /** Split payment: the hotel's subaccount receives the amount minus `transactionChargeKobo`. */
  subaccount?: string;
  transactionChargeKobo?: number;
  bearer?: 'account' | 'subaccount';
  channels?: string[];
}

export interface PaystackBank {
  code: string;
  name: string;
  slug: string;
  type: string;
}

export interface VerifyResult {
  /** Paystack transaction status: success | failed | abandoned | ongoing | pending | reversed | queued */
  status: string;
  amountKobo: number;
  currency: string;
  paidAt: string | null;
  channel: string | null;
  id: string | null;
  metadata: Record<string, unknown> | null;
}

export interface RefundResult {
  id: string;
  /** pending | processing | processed | failed */
  status: string;
}

interface Envelope<T> {
  status?: boolean;
  message?: string;
  data?: T;
}

/**
 * Minimal Paystack REST client (https://paystack.com/docs/api/) on global
 * fetch. Without PAYSTACK_SECRET_KEY it runs in mock mode (development only):
 * banks, account resolution, subaccounts and refunds are simulated locally,
 * and checkouts go to the web app's mock payment page.
 */
@Injectable()
export class PaystackClient {
  private readonly logger = new Logger(PaystackClient.name);

  constructor(private readonly config: AppConfigService) {}

  get enabled(): boolean {
    return this.config.paystackEnabled;
  }

  get providerName(): 'paystack' | 'mock' {
    return this.enabled ? 'paystack' : 'mock';
  }

  private async request<T>(method: 'GET' | 'POST' | 'PUT', path: string, body?: unknown): Promise<T> {
    const key = this.config.get('PAYSTACK_SECRET_KEY');
    if (!key) throw new Error('Paystack is not configured');
    let res: Response;
    try {
      const init: RequestInit = {
        method,
        headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
        signal: AbortSignal.timeout(15_000),
      };
      if (method !== 'GET' && body !== undefined) init.body = JSON.stringify(body);
      res = await fetch(`${this.config.get('PAYSTACK_BASE_URL')}${path}`, init);
    } catch (err) {
      this.logger.error(`Paystack ${method} ${path} failed: ${String(err)}`);
      throw providerError('Could not reach the payment provider');
    }
    const parsed = (await res.json().catch(() => null)) as Envelope<T> | null;
    if (!res.ok || !parsed?.status) {
      this.logger.error(`Paystack ${method} ${path} rejected (${res.status}): ${parsed?.message ?? 'no body'}`);
      throw new PaystackRejection(res.status, parsed?.message ?? 'The payment provider rejected the request');
    }
    return parsed.data as T;
  }

  async initializeTransaction(p: InitializeParams): Promise<{ authorizationUrl: string; accessCode: string }> {
    try {
      const data = await this.request<{ authorization_url?: string; access_code?: string }>('POST', '/transaction/initialize', {
        email: p.email,
        amount: p.amountKobo,
        currency: 'NGN',
        reference: p.reference,
        callback_url: p.callbackUrl,
        metadata: p.metadata,
        ...(p.subaccount && { subaccount: p.subaccount }),
        ...(p.transactionChargeKobo !== undefined && p.subaccount && { transaction_charge: p.transactionChargeKobo }),
        ...(p.bearer && p.subaccount && { bearer: p.bearer }),
        ...(p.channels && { channels: p.channels }),
      });
      if (!data?.authorization_url) throw providerError('The payment provider did not return a checkout URL');
      return { authorizationUrl: data.authorization_url, accessCode: data.access_code ?? '' };
    } catch (e) {
      throw asProviderError(e);
    }
  }

  async verifyTransaction(reference: string): Promise<VerifyResult> {
    try {
      const d = await this.request<{
        status?: string;
        amount?: number;
        currency?: string;
        paid_at?: string | null;
        channel?: string | null;
        id?: number | string;
        metadata?: Record<string, unknown> | string | null;
      }>('GET', `/transaction/verify/${encodeURIComponent(reference)}`);
      return {
        status: d?.status ?? 'pending',
        amountKobo: Number(d?.amount ?? 0),
        currency: d?.currency ?? 'NGN',
        paidAt: d?.paid_at ?? null,
        channel: d?.channel ?? null,
        id: d?.id !== undefined ? String(d.id) : null,
        metadata: d?.metadata && typeof d.metadata === 'object' ? d.metadata : null,
      };
    } catch (e) {
      throw asProviderError(e);
    }
  }

  async listBanks(): Promise<PaystackBank[]> {
    if (!this.enabled) return MOCK_BANKS;
    try {
      const rows = await this.request<{ code: string; name: string; slug: string; type: string; active?: boolean }[]>(
        'GET',
        '/bank?country=nigeria&perPage=200',
      );
      return (rows ?? []).filter((b) => b.active !== false).map((b) => ({ code: b.code, name: b.name, slug: b.slug, type: b.type }));
    } catch (e) {
      throw asProviderError(e);
    }
  }

  /** Account name for a NUBAN, or null when the bank says it does not exist. */
  async resolveAccount(accountNumber: string, bankCode: string): Promise<string | null> {
    if (!this.enabled) {
      if (!MOCK_BANKS.some((b) => b.code === bankCode)) return null;
      return mockAccountName(accountNumber);
    }
    try {
      const d = await this.request<{ account_name?: string }>(
        'GET',
        `/bank/resolve?account_number=${encodeURIComponent(accountNumber)}&bank_code=${encodeURIComponent(bankCode)}`,
      );
      return d?.account_name ?? null;
    } catch (e) {
      if (e instanceof PaystackRejection && e.httpStatus < 500) return null;
      throw asProviderError(e);
    }
  }

  async createSubaccount(p: { businessName: string; bankCode: string; accountNumber: string; email?: string }): Promise<{ subaccountCode: string; verified: boolean }> {
    if (!this.enabled) {
      const code = `ACCT_mock${createHash('sha256').update(`${p.bankCode}:${p.accountNumber}`).digest('hex').slice(0, 10)}`;
      return { subaccountCode: code, verified: true };
    }
    try {
      const d = await this.request<{ subaccount_code?: string; is_verified?: boolean }>('POST', '/subaccount', {
        business_name: p.businessName,
        settlement_bank: p.bankCode,
        account_number: p.accountNumber,
        percentage_charge: 0,
        ...(p.email && { primary_contact_email: p.email }),
      });
      if (!d?.subaccount_code) throw providerError('The payment provider did not return a subaccount');
      return { subaccountCode: d.subaccount_code, verified: d.is_verified ?? true };
    } catch (e) {
      throw asProviderError(e);
    }
  }

  async updateSubaccount(code: string, p: { businessName: string; bankCode: string; accountNumber: string }): Promise<{ subaccountCode: string; verified: boolean }> {
    if (!this.enabled) return this.createSubaccount(p);
    try {
      const d = await this.request<{ subaccount_code?: string; is_verified?: boolean }>('PUT', `/subaccount/${encodeURIComponent(code)}`, {
        business_name: p.businessName,
        settlement_bank: p.bankCode,
        account_number: p.accountNumber,
        percentage_charge: 0,
      });
      return { subaccountCode: d?.subaccount_code ?? code, verified: d?.is_verified ?? true };
    } catch (e) {
      throw asProviderError(e);
    }
  }

  /** POST /refund. In mock mode the refund is processed at once. */
  async refund(reference: string, amountKobo: number, note?: string): Promise<RefundResult> {
    if (!this.enabled) return { id: `mock_rf_${randomBytes(6).toString('hex')}`, status: 'processed' };
    try {
      const d = await this.request<{ id?: number | string; status?: string }>('POST', '/refund', {
        transaction: reference,
        amount: amountKobo,
        currency: 'NGN',
        ...(note && { merchant_note: note.slice(0, 200) }),
      });
      return { id: String(d?.id ?? ''), status: d?.status ?? 'pending' };
    } catch (e) {
      throw asProviderError(e);
    }
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

/** A 4xx/5xx answer from Paystack (kept apart from network failures). */
export class PaystackRejection extends Error {
  constructor(
    readonly httpStatus: number,
    message: string,
  ) {
    super(message);
  }
}

function asProviderError(e: unknown): unknown {
  if (e instanceof PaystackRejection) return providerError(e.message);
  return e;
}

function providerError(message: string): AppException {
  return new AppException(HttpStatus.BAD_GATEWAY, ErrorCode.PAYMENT_PROVIDER_ERROR, message);
}
