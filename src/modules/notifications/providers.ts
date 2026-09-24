import { Logger } from '@nestjs/common';
import nodemailer, { type Transporter } from 'nodemailer';
import type { NotificationChannel } from '../../generated/prisma/enums.js';
import type { AppConfigService } from '../../config/app-config.service.js';
import type { DevOutboxService } from './dev-outbox.service.js';

export interface ProviderMessage {
  to: string;
  subject: string | null;
  text: string;
  html: string | null;
  /** Display name for the email sender (e.g. the hotel for booking-site mail). */
  fromName?: string | null;
  /** M6 white-label: full sender on the hotel's verified domain ("Name <addr>"). */
  fromAddress?: string | null;
  /** M6 white-label: the hotel's approved SMS sender ID. */
  smsSenderId?: string | null;
  template: string;
  meta?: Record<string, unknown>;
  /** WhatsApp: send this approved template (outside the 24-hour window) instead of free-form text. */
  waTemplate?: { name: string; language: string; params: string[] } | null;
}

export interface SendResult {
  providerMessageId: string | null;
  /** true when the message was captured by the dev outbox instead of delivered. */
  outbox?: boolean;
}

export interface ChannelProvider {
  readonly name: 'resend' | 'smtp' | 'termii' | 'whatsapp' | 'outbox' | 'log';
  send(msg: ProviderMessage): Promise<SendResult>;
}

/** Thrown for failures worth retrying (network, 5xx, 429). */
export class ProviderError extends Error {}

async function postJson(url: string, body: unknown, headers: Record<string, string> = {}): Promise<Record<string, unknown>> {
  let res: Response;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(15_000),
    });
  } catch (e) {
    throw new ProviderError(`network: ${(e as Error).message}`);
  }
  const text = await res.text();
  if (!res.ok) throw new ProviderError(`HTTP ${res.status}: ${text.slice(0, 300)}`);
  try {
    return JSON.parse(text) as Record<string, unknown>;
  } catch {
    return {};
  }
}

function fromAddress(config: AppConfigService, name?: string | null): string {
  const configured = config.get('EMAIL_FROM') ?? `${config.get('APP_NAME')} <${config.get('SUPPORT_EMAIL')}>`;
  if (!name) return configured;
  const addr = configured.match(/<([^>]+)>/)?.[1] ?? configured;
  const safe = name.replace(/["<>\r\n]/g, '').slice(0, 80);
  return `"${safe} via ${config.get('APP_NAME')}" <${addr}>`;
}

export class ResendEmailProvider implements ChannelProvider {
  readonly name = 'resend' as const;
  constructor(private readonly config: AppConfigService) {}

  async send(m: ProviderMessage): Promise<SendResult> {
    const res = await postJson(
      `${this.config.get('RESEND_BASE_URL').replace(/\/$/, '')}/emails`,
      { from: m.fromAddress ?? fromAddress(this.config, m.fromName), to: [m.to], subject: m.subject ?? '', html: m.html ?? undefined, text: m.text },
      { Authorization: `Bearer ${this.config.get('RESEND_API_KEY')}` },
    );
    return { providerMessageId: typeof res.id === 'string' ? res.id : null };
  }
}

export class SmtpEmailProvider implements ChannelProvider {
  readonly name = 'smtp' as const;
  private readonly transport: Transporter;

  constructor(private readonly config: AppConfigService) {
    this.transport = nodemailer.createTransport({
      host: config.get('SMTP_HOST'),
      port: config.get('SMTP_PORT'),
      secure: config.get('SMTP_SECURE'),
      auth: config.get('SMTP_USER') ? { user: config.get('SMTP_USER')!, pass: config.get('SMTP_PASS') ?? '' } : undefined,
    });
  }

  async send(m: ProviderMessage): Promise<SendResult> {
    try {
      const info = await this.transport.sendMail({ from: m.fromAddress ?? fromAddress(this.config, m.fromName), to: m.to, subject: m.subject ?? '', text: m.text, html: m.html ?? undefined });
      return { providerMessageId: info.messageId ?? null };
    } catch (e) {
      throw new ProviderError(`smtp: ${(e as Error).message}`);
    }
  }
}

/** Termii SMS: POST /api/sms/send (https://developers.termii.com/messaging-api). */
export class TermiiSmsProvider implements ChannelProvider {
  readonly name = 'termii' as const;
  constructor(private readonly config: AppConfigService) {}

  async send(m: ProviderMessage): Promise<SendResult> {
    const res = await postJson(`${this.config.get('TERMII_BASE_URL').replace(/\/$/, '')}/api/sms/send`, {
      api_key: this.config.get('TERMII_API_KEY'),
      to: m.to.replace(/^\+/, ''),
      from: m.smsSenderId ?? this.config.get('TERMII_SENDER_ID'),
      sms: m.text,
      type: 'plain',
      channel: this.config.get('TERMII_CHANNEL'),
    });
    const id = res.message_id ?? res.messageId;
    return { providerMessageId: typeof id === 'string' || typeof id === 'number' ? String(id) : null };
  }
}

/** WhatsApp Cloud API text message (see the M2 digest provider for the 24-hour window caveat). */
export class WhatsAppProvider implements ChannelProvider {
  readonly name = 'whatsapp' as const;
  constructor(private readonly config: AppConfigService) {}

  async send(m: ProviderMessage): Promise<SendResult> {
    const base = this.config.get('WHATSAPP_API_BASE_URL').replace(/\/$/, '');
    const to = m.to.replace(/^\+/, '');
    const payload = m.waTemplate
      ? { messaging_product: 'whatsapp', to, type: 'template', template: whatsappTemplatePayload(m.waTemplate) }
      : { messaging_product: 'whatsapp', to, type: 'text', text: { preview_url: true, body: m.text } };
    const res = await postJson(`${base}/${this.config.get('WHATSAPP_PHONE_ID')}/messages`, payload, { Authorization: `Bearer ${this.config.get('WHATSAPP_TOKEN')}` });
    const messages = res.messages as { id?: string }[] | undefined;
    return { providerMessageId: messages?.[0]?.id ?? null };
  }
}

/** Cloud API `template` object: body parameters in order (plus the code button of an OTP template). */
export function whatsappTemplatePayload(t: { name: string; language: string; params: string[] }) {
  const body = { type: 'body', parameters: t.params.map((text) => ({ type: 'text', text })) };
  const components: Record<string, unknown>[] = [body];
  if (t.name === 'otp_code') components.push({ type: 'button', sub_type: 'url', index: '0', parameters: [{ type: 'text', text: t.params[0] }] });
  return { name: t.name, language: { code: t.language }, components };
}

/** Development: nothing leaves the machine; the message lands in the dev outbox. */
export class OutboxProvider implements ChannelProvider {
  readonly name = 'outbox' as const;
  private readonly logger = new Logger('DevOutbox');

  constructor(
    private readonly outbox: DevOutboxService,
    private readonly channel: NotificationChannel,
  ) {}

  async send(m: ProviderMessage): Promise<SendResult> {
    const id = await this.outbox.push({
      channel: this.channel,
      template: m.template,
      to: m.to,
      subject: m.subject,
      text: m.text,
      html: m.html,
      meta: {
        ...m.meta,
        ...(m.waTemplate && { waTemplate: m.waTemplate.name, waParams: m.waTemplate.params }),
        ...(m.fromAddress && { from: m.fromAddress }),
        ...(m.smsSenderId && { senderId: m.smsSenderId }),
      },
    });
    const otp = typeof m.meta?.otpCode === 'string' ? ` code=${m.meta.otpCode}` : '';
    this.logger.log(`${this.channel} ${m.template} to ${m.to}${otp}${m.subject ? ` "${m.subject}"` : ''}`);
    return { providerMessageId: id, outbox: true };
  }
}

/** Production without a provider: refuse loudly (the log row becomes FAILED). */
export class UnconfiguredProvider implements ChannelProvider {
  readonly name = 'log' as const;
  constructor(private readonly channel: NotificationChannel) {}

  send(): Promise<SendResult> {
    return Promise.reject(new Error(`No ${this.channel.toLowerCase()} provider is configured`));
  }
}

export function pickProviders(config: AppConfigService, outbox: DevOutboxService): Record<NotificationChannel, ChannelProvider> {
  const dev = !config.isProduction;
  const fallback = (c: NotificationChannel): ChannelProvider => (dev ? new OutboxProvider(outbox, c) : new UnconfiguredProvider(c));
  return {
    EMAIL: config.get('RESEND_API_KEY')
      ? new ResendEmailProvider(config)
      : config.get('SMTP_HOST')
        ? new SmtpEmailProvider(config)
        : fallback('EMAIL'),
    SMS: config.get('TERMII_API_KEY') ? new TermiiSmsProvider(config) : fallback('SMS'),
    WHATSAPP: config.get('WHATSAPP_TOKEN') && config.get('WHATSAPP_PHONE_ID') ? new WhatsAppProvider(config) : fallback('WHATSAPP'),
  };
}
