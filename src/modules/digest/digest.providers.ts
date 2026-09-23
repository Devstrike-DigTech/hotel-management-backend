import { Logger } from '@nestjs/common';
import type { DigestChannel, DigestStatus } from '../../generated/prisma/enums.js';
import { maskPhone } from '../../common/utils/phone.js';
import { humanDate } from '../../common/time/lagos.js';
import { whatsappTemplatePayload } from '../notifications/providers.js';
import { cleanParam } from '../whatsapp/templates.registry.js';
import type { DigestData } from './digest.render.js';

export interface DeliveryResult {
  status: DigestStatus;
  error?: string;
}

/** How the owner digest leaves the building. */
export interface DigestProvider {
  readonly channel: DigestChannel;
  send(recipients: string[], body: string, data?: DigestData): Promise<DeliveryResult>;
}

/** Parameters of the approved `owner_daily_digest` template. */
export function digestTemplateParams(d: DigestData): string[] {
  const naira = (kobo: number) => `₦${Math.round(kobo / 100).toLocaleString('en-NG')}`;
  const guard = d.openFlags
    ? `${d.openFlags} open flag${d.openFlags === 1 ? '' : 's'}${d.topFlags[0] ? `, top: ${d.topFlags[0].title}` : ''}`
    : 'no open flags';
  return [
    d.hotelName,
    humanDate(d.businessDate),
    String(d.roomsSold),
    String(d.roomsAvailable),
    `${Math.round(d.occupancyRate * 100)}%`,
    naira(d.totalRevenueKobo),
    naira(d.paymentsTotalKobo),
    String(d.arrivals),
    String(d.departures),
    String(d.dayUseCount),
    guard,
  ].map(cleanParam);
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

  async send(recipients: string[], body: string, data?: DigestData): Promise<DeliveryResult> {
    if (!recipients.length) return { status: 'FAILED', error: 'No recipients configured' };
    // Outside the 24-hour window only approved templates deliver: send the digest template.
    const template = data ? whatsappTemplatePayload({ name: 'owner_daily_digest', language: 'en', params: digestTemplateParams(data) }) : null;
    const errors: string[] = [];
    for (const to of recipients) {
      try {
        const res = await this.fetchImpl(`${this.baseUrl.replace(/\/$/, '')}/${this.phoneId}/messages`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${this.token}`, 'Content-Type': 'application/json' },
          body: JSON.stringify(
            template
              ? { messaging_product: 'whatsapp', to: to.replace(/^\+/, ''), type: 'template', template }
              : { messaging_product: 'whatsapp', to: to.replace(/^\+/, ''), type: 'text', text: { preview_url: false, body } },
          ),
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
