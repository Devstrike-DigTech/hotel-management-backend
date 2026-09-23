export const BILLING_QUEUE = 'billing';
export const DUNNING_JOB = 'dunning';
export const DUNNING_SCHEDULER_ID = 'dunning-daily';
/** 02:00 every day, Lagos time. */
export const DUNNING_CRON = '0 2 * * *';
export const DUNNING_TZ = 'Africa/Lagos';

/** ioredis connection options from a redis:// URL. */
export function redisConnection(url: string) {
  const u = new URL(url);
  return {
    host: u.hostname,
    port: Number(u.port || 6379),
    username: u.username || undefined,
    password: u.password ? decodeURIComponent(u.password) : undefined,
    db: u.pathname && u.pathname !== '/' ? Number(u.pathname.slice(1)) : 0,
    ...(u.protocol === 'rediss:' && { tls: {} }),
    maxRetriesPerRequest: null,
  };
}
