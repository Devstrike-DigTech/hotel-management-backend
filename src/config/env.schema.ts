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

export function validateEnv(raw: Record<string, unknown>): Env {
  const parsed = envSchema.safeParse(raw);
  if (!parsed.success) {
    const problems = parsed.error.issues
      .map((i) => `  - ${i.path.join('.')}: ${i.message}`)
      .join('\n');
    throw new Error(`Invalid environment configuration:\n${problems}`);
  }
  const extra = checkStorage(parsed.data);
  if (extra.length) {
    throw new Error(`Invalid environment configuration:\n${extra.join('\n')}`);
  }
  return parsed.data;
}
