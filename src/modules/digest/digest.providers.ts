import { Logger } from '@nestjs/common';
import type { DigestChannel, DigestStatus } from '../../generated/prisma/enums.js';
import { maskPhone } from '../../common/utils/phone.js';

export interface DeliveryResult {
  status: DigestStatus;
  error?: string;
}

/** How the owner digest leaves the building. */
export interface DigestProvider {
  readonly channel: DigestChannel;
  send(recipients: string[], body: string): Promise<DeliveryResult>;
}

export const DIGEST_PROVIDER = Symbol('DIGEST_PROVIDER');

/** Development / unconfigured: writes the digest to the log; it is stored either way. */
export class LogDigestProvider implements DigestProvider {
  readonly channel = 'LOG' as const;
  private readonly logger = new Logger('OwnerDigest');

  send(recipients: string[], body: string): Promise<DeliveryResult> {
    this.logger.log(`Digest for ${recipients.map(maskPhone).join(', ') || '(no recipients)'}:\n${body}`);
    return Promise.resolve({ status: 'LOGGED' });
  }
}

/**
 * WhatsApp Cloud API (graph.facebook.com /{phone-id}/messages). Note: outside
 * a 24-hour customer-service window WhatsApp only delivers approved template
 * messages; production accounts should register a digest template.
 */
export class WhatsAppDigestProvider implements DigestProvider {
  readonly channel = 'WHATSAPP' as const;

  constructor(
    private readonly token: string,
    private readonly phoneId: string,
    private readonly baseUrl: string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  async send(recipients: string[], body: string): Promise<DeliveryResult> {
    if (!recipients.length) return { status: 'FAILED', error: 'No recipients configured' };
    const errors: string[] = [];
    for (const to of recipients) {
      try {
        const res = await this.fetchImpl(`${this.baseUrl.replace(/\/$/, '')}/${this.phoneId}/messages`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${this.token}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ messaging_product: 'whatsapp', to: to.replace(/^\+/, ''), type: 'text', text: { preview_url: false, body } }),
          signal: AbortSignal.timeout(15_000),
        });
        if (!res.ok) errors.push(`${maskPhone(to)}: HTTP ${res.status} ${(await res.text()).slice(0, 200)}`);
      } catch (e) {
        errors.push(`${maskPhone(to)}: ${(e as Error).message}`);
      }
    }
    if (errors.length === recipients.length) return { status: 'FAILED', error: errors.join('; ') };
    return errors.length ? { status: 'SENT', error: `Partial: ${errors.join('; ')}` } : { status: 'SENT' };
  }
}
