import { z } from 'zod';

const bool = z
  .enum(['true', 'false', '1', '0'])
  .transform((v) => v === 'true' || v === '1');

/**
 * Environment contract. The process refuses to start when a required value is
 * missing or malformed, with a message listing every problem at once.
 */
export const envSchema = z.object({
  NODE_ENV: z
    .enum(['development', 'test', 'production'])
    .default('development'),
  PORT: z.coerce.number().int().positive().default(4000),

  APP_NAME: z.string().min(1),
  APP_DOMAIN: z.string().min(1),
  SUPPORT_EMAIL: z.email(),

  /** Runtime role for tenant requests (hotel_app). */
  DATABASE_URL: z.url(),
  /** Role for cross-tenant work: platform console, webhooks, jobs (hotel_platform). */
  DATABASE_PLATFORM_URL: z.url(),
  DATABASE_MIGRATION_URL: z.url().optional(),
  DATABASE_POOL_MAX: z.coerce.number().int().positive().default(10),
  DATABASE_PLATFORM_POOL_MAX: z.coerce.number().int().positive().default(4),
  /** HMAC key that signs the per-transaction tenant context (see README). */
  DB_CONTEXT_SECRET: z.string().min(32),
  /** Key material for AES-256-GCM encryption of guest ID numbers. */
  GUEST_DATA_KEY: z.string().min(32),
  /** Signs guest share links and short-lived file URLs. */
  SHARE_TOKEN_SECRET: z.string().min(32),
  /** Public base URL of this API (used in signed file URLs). */
  API_PUBLIC_URL: z.url().default('http://localhost:4000'),
  STORAGE_DRIVER: z.enum(['local', 's3']).default('local'),
  STORAGE_LOCAL_DIR: z.string().default('./storage'),
  S3_BUCKET: z.string().optional(),
  S3_REGION: z.string().default('auto'),
  S3_ENDPOINT: z.string().optional(),
  S3_ACCESS_KEY_ID: z.string().optional(),
  S3_SECRET_ACCESS_KEY: z.string().optional(),
  S3_FORCE_PATH_STYLE: bool.default(true),
  /** WhatsApp Cloud API for the owner digest. Empty = log and store only. */
  WHATSAPP_TOKEN: z
    .string()
    .optional()
    .transform((v) => (v && v.trim().length > 0 ? v.trim() : undefined)),
  WHATSAPP_PHONE_ID: z
    .string()
    .optional()
    .transform((v) => (v && v.trim().length > 0 ? v.trim() : undefined)),
  WHATSAPP_API_BASE_URL: z.url().default('https://graph.facebook.com/v21.0'),
  /** Meta app secret: verifies X-Hub-Signature-256 on the inbound webhook. Empty = every POST rejected. */
  WHATSAPP_APP_SECRET: z
    .string()
    .optional()
    .transform((v) => (v && v.trim().length > 0 ? v.trim() : undefined)),
  /** Token Meta echoes when subscribing the webhook (GET hub.verify_token). */
  WHATSAPP_VERIFY_TOKEN: z
    .string()
    .optional()
    .transform((v) => (v && v.trim().length > 0 ? v.trim() : undefined)),
  /** Comma-separated template names Meta has approved (shown as APPROVED in the admin). */
  WHATSAPP_APPROVED_TEMPLATES: z.string().default(''),
  /**
   * Shared secret between the web server and the API. When a request carries
   * X-Proxy-Auth equal to it, X-Client-IP is used as the client IP for rate
   * limiting. Empty = off (the header is ignored); when set it must be at
   * least 16 characters, so a weak value fails at start-up.
   */
  TRUSTED_PROXY_SECRET: z
    .string()
    .optional()
    .transform((v) => (v && v.trim().length > 0 ? v.trim() : undefined))
    .refine((v) => v === undefined || v.length >= 16, { message: 'TRUSTED_PROXY_SECRET must be at least 16 characters (or empty to turn it off)' }),
  REDIS_URL: z.url(),

  JWT_ACCESS_SECRET: z.string().min(32),
  JWT_PLATFORM_SECRET: z.string().min(32),
  JWT_REFRESH_SECRET: z.string().min(32),
  JWT_ACCESS_TTL: z.string().default('15m'),
  REFRESH_TOKEN_TTL_DAYS: z.coerce.number().int().positive().default(30),

  PAYSTACK_SECRET_KEY: z
    .string()
    .optional()
    .transform((v) => (v && v.trim().length > 0 ? v.trim() : undefined)),
  PAYSTACK_BASE_URL: z.url().default('https://api.paystack.co'),

  // M5: channel manager (Channex). Empty key = in-process mock (not allowed in production).
  CHANNEX_API_KEY: z.string().optional().transform((v) => v || undefined),
  CHANNEX_BASE_URL: z.url().default('https://staging.channex.io/api/v1'),
  /** Verifies X-Channex-Signature on POST /webhooks/channex; empty = every delivery rejected. */
  CHANNEX_WEBHOOK_SECRET: z.string().optional().transform((v) => v || undefined),
  /** Minutes between iCal imports (default 15). */
  ICAL_POLL_MINUTES: z.coerce.number().int().min(5).max(1440).default(15),
  /**
   * Development / tests only: hostnames whose feed URLs may resolve to private
   * addresses (e.g. "localhost" for a local stub). Refused in production.
   */
  OUTBOUND_ALLOW_PRIVATE_HOSTS: z
    .string()
    .optional()
    .transform((v) => (v ?? '').split(',').map((h) => h.trim().toLowerCase()).filter(Boolean)),
  // M5: custom domains.
  /** DNS lookups for custom domains: system (node:dns) or mock (in-memory; dev and tests). */
  DNS_PROVIDER: z.enum(['system', 'mock']).optional(),
  /** CNAME target hotels point their domain at (default sites.<APP_DOMAIN>). */
  CUSTOM_DOMAIN_TARGET: z.string().optional().transform((v) => v || undefined),

  ADMIN_URL: z.url(),
  WEB_URL: z.url(),
  CORS_ORIGINS: z
    .string()
    .default('http://localhost:3000,http://localhost:3001')
    .transform((v) =>
      v
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean),
    ),

  // --- M3: guests, notifications -------------------------------------------
  /** Signs guest access tokens (audience `guest`). */
  GUEST_JWT_SECRET: z.string().min(32),
  /** Signs quote tokens, manage-booking links, review links, magic links and OTP hashes. */
  GUEST_TOKEN_SECRET: z.string().min(32),
  GUEST_ACCESS_TTL_SECONDS: z.coerce.number().int().positive().default(3600),
  /** Email sender, e.g. "HotelOS <bookings@hotelos.ng>". Defaults to APP_NAME <SUPPORT_EMAIL>. */
  EMAIL_FROM: z
    .string()
    .optional()
    .transform((v) => (v && v.trim().length > 0 ? v.trim() : undefined)),
  /** Resend (https://resend.com) API key. Preferred email provider when set. */
  RESEND_API_KEY: z
    .string()
    .optional()
    .transform((v) => (v && v.trim().length > 0 ? v.trim() : undefined)),
  RESEND_BASE_URL: z.url().default('https://api.resend.com'),
  /** SMTP (nodemailer) when RESEND_API_KEY is not set. */
  SMTP_HOST: z
    .string()
    .optional()
    .transform((v) => (v && v.trim().length > 0 ? v.trim() : undefined)),
  SMTP_PORT: z.coerce.number().int().positive().default(587),
  SMTP_USER: z
    .string()
    .optional()
    .transform((v) => (v && v.trim().length > 0 ? v.trim() : undefined)),
  SMTP_PASS: z
    .string()
    .optional()
    .transform((v) => (v && v.trim().length > 0 ? v.trim() : undefined)),
  SMTP_SECURE: bool.default(false),
  /** Termii SMS (https://developers.termii.com). */
  TERMII_API_KEY: z
    .string()
    .optional()
    .transform((v) => (v && v.trim().length > 0 ? v.trim() : undefined)),
  TERMII_SENDER_ID: z.string().default('HotelOS'),
  TERMII_BASE_URL: z.url().default('https://api.ng.termii.com'),
  TERMII_CHANNEL: z.enum(['generic', 'dnd', 'whatsapp']).default('generic'),
  /** Where orphaned-payment alerts for the platform go (defaults to SUPPORT_EMAIL). */
  PLATFORM_ALERT_EMAIL: z
    .string()
    .optional()
    .transform((v) => (v && v.trim().length > 0 ? v.trim() : undefined)),
  /** Set to false to switch off the Redis rate limits on public endpoints. */
  PUBLIC_RATE_LIMITS: bool.default(true),

  // --- M6: Enterprise tier and the platform console --------------------------
  /** Browser origins allowed on /api/v1/platform/* (the platform console only). */
  PLATFORM_ORIGINS: z
    .string()
    .default('http://localhost:3002')
    .transform((v) =>
      v
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean),
    ),
  /** Base URL of the platform console (invitation links). Default: the first PLATFORM_ORIGINS entry. */
  PLATFORM_APP_URL: z.url().optional(),
  /**
   * Key material for platform secrets at rest (TOTP secrets, dedicated DB URLs,
   * SSO client secrets, webhook signing secrets). Default: derived from
   * GUEST_DATA_KEY. Rotating it makes those values unreadable.
   */
  PLATFORM_DATA_KEY: z
    .string()
    .optional()
    .transform((v) => (v && v.trim().length > 0 ? v.trim() : undefined))
    .refine((v) => v === undefined || v.length >= 32, { message: 'PLATFORM_DATA_KEY must be at least 32 characters' }),
  /**
   * Owner-role URL with CREATEDB used to create and fill dedicated tenant
   * databases (and by `pnpm db:migrate:all`). Default outside production:
   * DATABASE_MIGRATION_URL. Empty in production = dedicated databases must be
   * created by an operator and pasted as a URL.
   */
  DATABASE_ADMIN_URL: z.url().optional(),
  /** Name prefix of dedicated tenant databases created by the API. */
  DEDICATED_DB_PREFIX: z
    .string()
    .regex(/^[a-z_][a-z0-9_]{0,30}$/)
    .default('hotel_t_'),
  /** Most dedicated databases with an open connection pool at once (least recently used are closed). */
  DEDICATED_DB_MAX_CLIENTS: z.coerce.number().int().min(1).max(500).default(20),
  /** Pool size per dedicated database and role. */
  DEDICATED_DB_POOL_MAX: z.coerce.number().int().min(1).max(50).default(3),
  /** Days the shared copy of a tenant is kept after its cutover to a dedicated database. */
  DEDICATED_SHARED_RETENTION_DAYS: z.coerce.number().int().min(0).max(90).default(7),
  /** CNAME target of white-label staff portal domains (default portal.<APP_DOMAIN>). */
  STAFF_PORTAL_TARGET: z.string().optional().transform((v) => v || undefined),
  /** Serve the development OIDC provider at /api/v1/dev/oidc (default: on outside production; never in production). */
  OIDC_MOCK_ENABLED: bool.optional(),
  /** Outbound webhook request timeout. */
  WEBHOOK_TIMEOUT_MS: z.coerce.number().int().min(1000).max(30_000).default(10_000),
  /** Partner API requests per minute per key: Enterprise plan / plans with an api_access add-on. */
  PARTNER_RATE_LIMIT_ENTERPRISE: z.coerce.number().int().positive().default(600),
  PARTNER_RATE_LIMIT_DEFAULT: z.coerce.number().int().positive().default(120),
  /** Days before offboarded tenants are deleted (NDPA grace). */
  OFFBOARDING_GRACE_DAYS: z.coerce.number().int().min(1).max(365).default(30),

  /** Requests per minute per IP on the auth endpoints. */
  AUTH_RATE_LIMIT: z.coerce.number().int().positive().default(20),
  /** Disable BullMQ workers and repeatable jobs (tests, one-off scripts). */
  JOBS_ENABLED: bool.default(true),
  SWAGGER_ENABLED: bool.default(true),
});

export type Env = z.infer<typeof envSchema>;

function checkStorage(env: Env): string[] {
  if (env.STORAGE_DRIVER !== 's3') return [];
  const missing = (
    ['S3_BUCKET', 'S3_ACCESS_KEY_ID', 'S3_SECRET_ACCESS_KEY'] as const
  ).filter((k) => !env[k]);
  return missing.map((k) => `  - ${k}: required when STORAGE_DRIVER=s3`);
}

function checkOutbound(env: Env): string[] {
  return env.NODE_ENV === 'production' && env.OUTBOUND_ALLOW_PRIVATE_HOSTS.length
    ? ['  - OUTBOUND_ALLOW_PRIVATE_HOSTS: must be empty in production']
    : [];
}

export function validateEnv(raw: Record<string, unknown>): Env {
  const parsed = envSchema.safeParse(raw);
  if (!parsed.success) {
    const problems = parsed.error.issues
      .map((i) => `  - ${i.path.join('.')}: ${i.message}`)
      .join('\n');
    throw new Error(`Invalid environment configuration:\n${problems}`);
  }
  const extra = [...checkStorage(parsed.data), ...checkOutbound(parsed.data)];
  if (parsed.data.NODE_ENV === 'production' && parsed.data.OIDC_MOCK_ENABLED) extra.push('  - OIDC_MOCK_ENABLED: must be off in production');
  if (extra.length) {
    throw new Error(`Invalid environment configuration:\n${extra.join('\n')}`);
  }
  return parsed.data;
}
