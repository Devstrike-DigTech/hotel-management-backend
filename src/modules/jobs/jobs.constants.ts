export const BILLING_QUEUE = 'billing';
export const DUNNING_JOB = 'dunning';
export const DUNNING_SCHEDULER_ID = 'dunning-daily';
/** 02:00 every day, Lagos time. */
export const DUNNING_CRON = '0 2 * * *';
export const DUNNING_TZ = 'Africa/Lagos';

export const OPERATIONS_QUEUE = 'operations';
export const GUEST_QUEUE = 'guest';
export const OPS_JOBS = {
  nightAudit: { name: 'night-audit', scheduler: 'night-audit-daily', cron: '0 2 * * *' },
  ownerDigest: { name: 'owner-digest', scheduler: 'owner-digest-daily', cron: '0 23 * * *' },
  guardSweep: { name: 'guard-sweep', scheduler: 'guard-sweep-hourly', cron: '5 * * * *' },
  idempotencyPurge: { name: 'idempotency-purge', scheduler: 'idempotency-purge-hourly', cron: '35 * * * *' },
  stayover: { name: 'housekeeping-stayover', scheduler: 'housekeeping-stayover-daily', cron: '0 7 * * *' },
  maintenanceSchedules: { name: 'maintenance-schedules', scheduler: 'maintenance-schedules-daily', cron: '0 6 * * *' },
  roomBlocks: { name: 'room-blocks', scheduler: 'room-blocks-hourly', cron: '1 * * * *' },
  cityLedgerStatements: { name: 'city-ledger-statements', scheduler: 'city-ledger-statements-monthly', cron: '0 6 1 * *' },
  cityLedgerReminders: { name: 'city-ledger-reminders', scheduler: 'city-ledger-reminders-daily', cron: '0 9 * * *' },
  guardAlerts: { name: 'guard-alerts', scheduler: 'guard-alerts-minutely', cron: '* * * * *' },
  // M5 (Pro)
  channelAriFlush: { name: 'channel-ari-flush', scheduler: 'channel-ari-flush-minutely', cron: '* * * * *' },
  channelAriSweep: { name: 'channel-ari-sweep', scheduler: 'channel-ari-sweep-15m', cron: '*/15 * * * *' },
  /** Runs every 5 minutes; each connection is imported every ICAL_POLL_MINUTES (default 15). */
  icalImport: { name: 'ical-import', scheduler: 'ical-import-5m', cron: '*/5 * * * *' },
  pricingNightly: { name: 'pricing-nightly', scheduler: 'pricing-nightly', cron: '0 3 * * *' },
  pricingPace: { name: 'pricing-pace', scheduler: 'pricing-pace-10m', cron: '*/10 * * * *' },
  loyaltyExpiry: { name: 'loyalty-expiry', scheduler: 'loyalty-expiry-daily', cron: '0 4 * * *' },
  domainChecks: { name: 'domain-checks', scheduler: 'domain-checks-10m', cron: '*/10 * * * *' },
} as const;

/** Query options whose value is a number (ioredis option names). */
const NUMERIC_REDIS_OPTIONS = new Set(['family', 'db', 'connectTimeout', 'commandTimeout', 'keepAlive', 'socketTimeout']);

/**
 * ioredis connection options from a redis:// or rediss:// URL. Query
 * parameters are kept as ioredis options, like `new Redis(url)` does (for
 * example `?family=0` for IPv6-only private networks such as Railway's);
 * numeric ones are converted. `maxRetriesPerRequest` stays null (BullMQ).
 */
export function redisConnection(url: string) {
  const u = new URL(url);
  const query: Record<string, string | number | boolean | object> = {};
  u.searchParams.forEach((value, key) => {
    if (key === 'tls') {
      if (value === 'true' || value === '1') query.tls = {};
      return;
    }
    if (NUMERIC_REDIS_OPTIONS.has(key) && /^-?\d+$/.test(value)) query[key] = Number(value);
    else if (value === 'true' || value === 'false') query[key] = value === 'true';
    else query[key] = value;
  });
  return {
    host: u.hostname.replace(/^\[|\]$/g, ''),
    port: Number(u.port || 6379),
    username: u.username ? decodeURIComponent(u.username) : undefined,
    password: u.password ? decodeURIComponent(u.password) : undefined,
    db: u.pathname && u.pathname !== '/' ? Number(u.pathname.slice(1)) : 0,
    ...(u.protocol === 'rediss:' && { tls: {} }),
    ...query,
    maxRetriesPerRequest: null,
  };
}
