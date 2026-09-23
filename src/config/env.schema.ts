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

  DATABASE_URL: z.url(),
  DATABASE_MIGRATION_URL: z.url().optional(),
  DATABASE_POOL_MAX: z.coerce.number().int().positive().default(10),
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

  /** Requests per minute per IP on the auth endpoints. */
  AUTH_RATE_LIMIT: z.coerce.number().int().positive().default(20),
  /** Disable BullMQ workers and repeatable jobs (tests, one-off scripts). */
  JOBS_ENABLED: bool.default(true),
  SWAGGER_ENABLED: bool.default(true),
});

export type Env = z.infer<typeof envSchema>;

export function validateEnv(raw: Record<string, unknown>): Env {
  const parsed = envSchema.safeParse(raw);
  if (!parsed.success) {
    const problems = parsed.error.issues
      .map((i) => `  - ${i.path.join('.')}: ${i.message}`)
      .join('\n');
    throw new Error(`Invalid environment configuration:\n${problems}`);
  }
  return parsed.data;
}
