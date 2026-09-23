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
  icalImport: { name: 'ical-import', scheduler: 'ical-import-15m', cron: '*/15 * * * *' },
  pricingNightly: { name: 'pricing-nightly', scheduler: 'pricing-nightly', cron: '0 3 * * *' },
  loyaltyExpiry: { name: 'loyalty-expiry', scheduler: 'loyalty-expiry-daily', cron: '0 4 * * *' },
  domainChecks: { name: 'domain-checks', scheduler: 'domain-checks-10m', cron: '*/10 * * * *' },
} as const;

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
