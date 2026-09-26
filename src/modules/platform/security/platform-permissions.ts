import { SetMetadata } from '@nestjs/common';
import type { PlatformRole } from '../../../generated/prisma/enums.js';

export const PLATFORM_PERMISSIONS = [
  { code: 'tenants.view', label: 'View tenants', description: 'See hotels, their subscriptions, usage, domains, databases and API usage.' },
  { code: 'tenants.manage', label: 'Manage tenants', description: 'Create hotels, change plans and status, extend trials, suspend and offboard.' },
  { code: 'plans.manage', label: 'Manage plans', description: 'Edit plans, prices, limits and features.' },
  { code: 'billing.view', label: 'View billing', description: 'See invoices, coupons, receivables and orphaned payments.' },
  { code: 'billing.manage', label: 'Manage billing', description: 'Create coupons, set custom prices, retry refunds.' },
  { code: 'commission.manage', label: 'Settle commission', description: 'Mark commission receivables settled.' },
  { code: 'reviews.moderate', label: 'Moderate reviews', description: 'Hide and restore guest reviews.' },
  { code: 'impersonate', label: 'Impersonate hotel staff', description: 'Open a time-boxed support session as a hotel user.' },
  { code: 'announcements.manage', label: 'Manage announcements', description: 'Broadcast in-app and email announcements to hotels.' },
  { code: 'support.handle', label: 'Handle support', description: 'Answer and manage support requests from hotels.' },
  { code: 'dedicated_db.manage', label: 'Manage dedicated databases', description: 'Provision, roll back and purge dedicated tenant databases.' },
  { code: 'platform_users.manage', label: 'Manage platform users', description: 'Invite staff, change roles, reset two-factor, deactivate.' },
  { code: 'audit.view', label: 'View the platform audit log', description: 'See and export every platform action.' },
  { code: 'system.view', label: 'View system health', description: 'Queues, deliveries, cron jobs; retry or clear failed jobs.' },
  { code: 'concierge.review', label: 'Review concierge services', description: "Approve, reject or hide hotels' concierge services and suspend a hotel's concierge." },
] as const;

export type PlatformPermission = (typeof PLATFORM_PERMISSIONS)[number]['code'];

const ALL = PLATFORM_PERMISSIONS.map((p) => p.code);

export const PLATFORM_ROLES: { role: PlatformRole; label: string; permissions: PlatformPermission[] }[] = [
  { role: 'SUPER_ADMIN', label: 'Super admin', permissions: [...ALL] },
  {
    role: 'OPERATIONS',
    label: 'Operations',
    permissions: ['tenants.view', 'tenants.manage', 'billing.view', 'reviews.moderate', 'impersonate', 'announcements.manage', 'support.handle', 'dedicated_db.manage', 'audit.view', 'system.view', 'concierge.review'],
  },
  { role: 'SUPPORT', label: 'Support', permissions: ['tenants.view', 'impersonate', 'support.handle', 'reviews.moderate', 'system.view', 'concierge.review'] },
  { role: 'FINANCE', label: 'Finance', permissions: ['tenants.view', 'billing.view', 'billing.manage', 'commission.manage', 'plans.manage', 'audit.view'] },
  { role: 'SALES_READONLY', label: 'Sales (read only)', permissions: ['tenants.view', 'billing.view'] },
];

export function platformPermissionsFor(role: string): Set<PlatformPermission> {
  return new Set(PLATFORM_ROLES.find((r) => r.role === role)?.permissions ?? []);
}

export const PLATFORM_PERMISSION_KEY = 'platform:permission';
export const STEP_UP_KEY = 'platform:stepUp';
export const PLATFORM_SUPER_KEY = 'platform:superAdmin';

/** The platform route needs every listed permission (403 PLATFORM_FORBIDDEN). */
export const PlatformPermissionRequired = (...codes: PlatformPermission[]) => SetMetadata(PLATFORM_PERMISSION_KEY, codes);

/** Sensitive platform action: a code re-entered in the last 10 minutes (403 STEP_UP_REQUIRED). */
export const RequireStepUp = () => SetMetadata(STEP_UP_KEY, true);

/** Only SUPER_ADMIN. */
export const SuperAdminOnly = () => SetMetadata(PLATFORM_SUPER_KEY, true);

export const STEP_UP_SECONDS = 600;
