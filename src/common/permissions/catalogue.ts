import type { StaffRole } from '../../generated/prisma/enums.js';

/**
 * The permission catalogue. Every route and every sensitive branch inside a
 * service is gated by one of these codes (`@RequirePermission`, `can()`).
 * System roles are fixed sets defined here; custom roles store a subset in
 * `custom_roles.permissions`. OWNER always holds every permission, including
 * ones added in later releases.
 */
export interface PermissionDef {
  code: string;
  label: string;
  description: string;
  /** Money, identity or access control: highlighted in the matrix editor. */
  sensitive: boolean;
}

export interface PermissionGroupDef {
  group: string;
  label: string;
  permissions: PermissionDef[];
}

const p = (code: string, label: string, description: string, sensitive = false): PermissionDef => ({ code, label, description, sensitive });

export const PERMISSION_GROUPS: PermissionGroupDef[] = [
  {
    group: 'reservations',
    label: 'Reservations',
    permissions: [
      p('reservations.view', 'View reservations', 'See bookings, availability, the tape chart and the day board.'),
      p('reservations.create', 'Create reservations', 'Make new bookings at the desk.'),
      p('reservations.edit', 'Change reservations', 'Change dates, rooms and guests; confirm and move stays.'),
      p('reservations.cancel', 'Cancel reservations', 'Cancel bookings and mark no-shows.'),
    ],
  },
  {
    group: 'frontdesk',
    label: 'Front desk',
    permissions: [
      p('frontdesk.checkin', 'Check guests in', 'Check in, complete the guest register, convert day use to a night.'),
      p('frontdesk.checkout', 'Check guests out', 'Check out and charge corporate accounts within their credit limit.'),
      p('frontdesk.override', 'Override desk rules', 'Check into a dirty room, check out with a balance, exceed a credit limit.', true),
    ],
  },
  {
    group: 'folio',
    label: 'Folios',
    permissions: [
      p('folio.view', 'View folios and invoices', 'See folios, invoices, receipts and tax settings.'),
      p('folio.charge', 'Post charges', 'Add extras to folios and open walk-in folios.'),
      p('folio.discount', 'Give discounts', 'Post discounts (above the threshold a second key is needed).'),
      p('folio.approve', 'Approve discounts (second key)', 'Approve discounts above the threshold with a PIN.', true),
      p('folio.void', 'Void entries', 'Correct folio entries by voiding them.', true),
      p('folio.refund', 'Refund guests', 'Pay money back to a guest.', true),
    ],
  },
  {
    group: 'payments',
    label: 'Payments',
    permissions: [
      p('payments.take', 'Take payments', 'Record cash, transfer and POS payments in your shift; record City Ledger payments.'),
      p('payments.special', 'Special payment methods', 'Record complimentary, online card and city-ledger payments by hand.', true),
    ],
  },
  {
    group: 'shifts',
    label: 'Cashier shifts',
    permissions: [
      p('shifts.own', 'Own cashier shift', 'Open and close your own shift (blind count).'),
      p('shifts.approve', 'Approve shifts', 'Approve closed shifts and close other people\'s shifts.', true),
      p('shifts.view_all', 'See every shift', 'See all shifts with their expected totals and variances.'),
    ],
  },
  {
    group: 'guests',
    label: 'Guests',
    permissions: [
      p('guests.view', 'View guests', 'See guest records (ID numbers masked).'),
      p('guests.edit', 'Edit guests', 'Create and change guest records and ID images.'),
      p('guests.reveal_id', 'Reveal ID numbers', 'Show a guest\'s full ID number (audited).', true),
      p('guests.export', 'Export guest data', 'NDPA data export and the guest register with full ID numbers.', true),
      p('guests.anonymise', 'Anonymise guests', 'Erase a guest\'s personal data on request (NDPA).', true),
    ],
  },
  {
    group: 'rooms',
    label: 'Rooms',
    permissions: [
      p('rooms.status', 'Change room status', 'Set any room status by hand.'),
      p('rooms.manage', 'Manage rooms', 'Create, edit and delete rooms and room types.'),
    ],
  },
  {
    group: 'housekeeping',
    label: 'Housekeeping',
    permissions: [
      p('housekeeping.view', 'View housekeeping', 'See the housekeeping board, tasks and lost & found.'),
      p('housekeeping.work', 'Do housekeeping', 'Start, tick and finish cleaning tasks; log lost & found; mark dirty rooms clean.'),
      p('housekeeping.assign', 'Assign housekeeping', 'Create and assign tasks, balance workloads, edit checklists.'),
      p('housekeeping.inspect', 'Inspect rooms', 'Pass or reject cleaned rooms (supervisor).'),
    ],
  },
  {
    group: 'maintenance',
    label: 'Maintenance',
    permissions: [
      p('maintenance.view', 'View maintenance', 'See tickets, room blocks, schedules and the diesel log.'),
      p('maintenance.report', 'Report issues', 'Open maintenance tickets and add comments and photos.'),
      p('maintenance.work', 'Work tickets', 'Update tickets assigned to you and log diesel deliveries.'),
      p('maintenance.manage', 'Manage maintenance', 'Assign tickets, block rooms, plan preventive work, edit the diesel log.'),
    ],
  },
  {
    group: 'rates',
    label: 'Rates and promotions',
    permissions: [
      p('rates.view', 'View rates', 'See rate plans, seasons, the rates calendar and promo codes.'),
      p('rates.manage', 'Manage rates', 'Change rate plans, seasons, overrides and restrictions; set custom prices on bookings.', true),
      p('promotions.manage', 'Manage promo codes', 'Create and change promo codes.'),
    ],
  },
  {
    group: 'corporate',
    label: 'Corporate accounts',
    permissions: [
      p('corporate.view', 'View corporate accounts', 'See corporate accounts and the City Ledger.'),
      p('corporate.manage', 'Manage corporate accounts', 'Create accounts, set credit limits, issue statements and send reminders.', true),
    ],
  },
  {
    group: 'reports',
    label: 'Reports',
    permissions: [
      p('reports.view', 'View reports', 'Daily flash, range reports, night audit runs and owner digests.'),
      p('reports.financial', 'Financial reports', 'Payments and shift reports, payouts and costs.', true),
    ],
  },
  {
    group: 'guard',
    label: 'Revenue Guard',
    permissions: [
      p('guard.view', 'View Revenue Guard', 'See Revenue Guard flags and alerts.'),
      p('guard.resolve', 'Resolve flags', 'Acknowledge, resolve or dismiss flags; run the sweep.'),
    ],
  },
  {
    group: 'admin',
    label: 'Administration',
    permissions: [
      p('staff.manage', 'Manage staff and roles', 'Add staff, change their roles and edit custom roles.', true),
      p('settings.manage', 'Manage settings', 'Hotel profile, taxes, booking, housekeeping and notification settings; run the night audit.', true),
      p('billing.manage', 'Manage subscription', 'Pay for the plan and see its invoices.', true),
      p('payouts.manage', 'Manage payouts', 'Set the bank account that receives online payments.', true),
    ],
  },
  {
    group: 'properties',
    label: 'Properties',
    permissions: [
      p('properties.manage', 'Add properties', 'Add hotels to the group (Pro).', true),
    ],
  },
  {
    group: 'pos',
    label: 'Point of sale',
    permissions: [
      p('pos.view', 'View POS', 'Open the POS terminal and see orders and POS reports.'),
      p('pos.order', 'Take orders', 'Open orders, add items, send them to the kitchen or bar, mark items unavailable.'),
      p('pos.settle', 'Settle bills', 'Take payment for orders or charge them to a room or company account.'),
      p('pos.discount', 'Discount bills', 'Discount orders (above the threshold a second key is needed).'),
      p('pos.void', 'Void sent items', 'Void items already sent to the kitchen or bar.', true),
      p('pos.manage', 'Manage menus and outlets', 'Outlets, menus, prices, modifiers and happy hours.', true),
      p('kds.view', 'Kitchen display', 'See kitchen and bar tickets and bump them.'),
    ],
  },
  {
    group: 'stock',
    label: 'Stock and minibar',
    permissions: [
      p('stock.view', 'View stock', 'See stock levels, movements and variance.'),
      p('stock.manage', 'Manage stock', 'Record purchases, counts and adjustments; set minibar par levels.', true),
      p('minibar.record', 'Record minibar use', 'Record what a guest took from the minibar (charged to the room).'),
    ],
  },
  {
    group: 'channels',
    label: 'Channel manager',
    permissions: [
      p('channels.view', 'View channels', 'See OTA connections, bookings, sync logs and OTA costs.'),
      p('channels.manage', 'Manage channels', 'Connect OTAs, map room types and push availability and rates.', true),
    ],
  },
  {
    group: 'pricing',
    label: 'Dynamic pricing',
    permissions: [
      p('pricing.view', 'View pricing', 'See price suggestions, events, competitor prices and the autopilot report.'),
      p('pricing.manage', 'Manage pricing', 'Accept or reject suggestions, set guardrails and autopilot.', true),
    ],
  },
  {
    group: 'inbox',
    label: 'Guest inbox',
    permissions: [
      p('inbox.view', 'Read guest messages', 'See WhatsApp conversations with guests.'),
      p('inbox.reply', 'Reply to guests', 'Reply to guests, add notes and turn requests into tasks.'),
      p('inbox.manage', 'Manage the inbox', 'Assign conversations to others, edit quick replies and inbox settings.'),
    ],
  },
  {
    group: 'loyalty',
    label: 'Loyalty',
    permissions: [
      p('loyalty.view', 'View loyalty', 'See members, points and statements.'),
      p('loyalty.redeem', 'Redeem points', 'Redeem a member\'s points on a folio (with their code or a manager PIN).'),
      p('loyalty.adjust', 'Adjust points', 'Add or remove points by hand (audited).', true),
      p('loyalty.manage', 'Manage the programme', 'Programme name, earn rate, tiers and expiry.', true),
    ],
  },
  {
    group: 'reviews',
    label: 'Reviews',
    permissions: [
      p('reviews.view', 'View reviews', 'See guest reviews and ratings.'),
      p('reviews.reply', 'Reply to reviews', 'Reply to reviews and report abusive ones.'),
    ],
  },
  {
    group: 'audit',
    label: 'Audit trail',
    permissions: [
      p('audit.view', 'View audit trail', 'See who did what, when.'),
      p('audit.export', 'Export audit trail', 'Download the audit trail as CSV or JSON.', true),
    ],
  },
  // M7
  {
    group: 'site',
    label: 'Booking site and extras',
    permissions: [
      p('site.manage', 'Brand Studio', 'Change the booking-site theme, template, logo and colours; publish and revert; preview links.'),
      p('forms.manage', 'Booking form builder', 'Choose the questions guests answer when they book; publish new versions.'),
      p('extras.manage', 'Extras and pickup points', 'Paid extras, pickup points with their prices, and local transport companies.'),
      p('transfers.view', 'See transfers', 'See the board of airport, motor-park and station pickups and drop-offs.'),
      p('transfers.manage', 'Run transfers', 'Confirm pickups, assign drivers, update their status and message the guest.'),
    ],
  },
  // M8
  {
    group: 'concierge',
    label: 'Concierge',
    permissions: [
      p('concierge.view', 'See concierge requests', 'See the concierge board and guest requests (private ones masked or hidden).'),
      p('concierge.work', 'Work concierge requests', 'Create requests for guests, send quotes, assign staff or vendors, update, complete.'),
      p('concierge.discreet', 'See private requests', 'See the service, notes and guest of private (discreet) requests. Every view is audited.', true),
      p('concierge.catalogue', 'Concierge catalogue and vendors', 'Services guests can ask for, their prices and questions, and the vendor directory.'),
      p('concierge.review', 'Review held requests', 'Clear or decline guest requests held by the content screen; receive SLA escalations.', true),
      p('concierge.settings', 'Concierge settings', 'Switch the concierge on, accept the acceptable-use policy, SLA targets, folio wording, retention.', true),
      p('concierge.reports', 'Concierge reports', 'Concierge reports, exports and vendor settlements.', true),
    ],
  },
  // M6 (Enterprise)
  {
    group: 'integrations',
    label: 'Integrations',
    permissions: [
      p('integrations.view', 'View API keys and webhooks', 'See API keys, webhook endpoints, deliveries and API usage.'),
      p('integrations.manage', 'Manage API keys and webhooks', 'Create, rotate and revoke API keys; add webhook endpoints, replay deliveries.', true),
    ],
  },
  {
    group: 'enterprise',
    label: 'Enterprise',
    permissions: [
      p('whitelabel.manage', 'Manage white-label settings', 'Brand kit, email sending domain, SMS sender ID and the staff portal domain.'),
      p('sso.manage', 'Manage single sign-on', 'Set up SSO with Google Workspace, Microsoft Entra ID or OIDC, and enforce it.', true),
      p('data.export', 'Export all hotel data', 'Download every record of the hotel group (includes guest ID numbers).', true),
    ],
  },
  {
    group: 'support',
    label: 'Platform support',
    permissions: [
      p('support.request', 'Contact platform support', 'Open support requests and reply to them (every built-in role has it).'),
      p('support.view_all', 'See every support request', 'See the support requests of the whole hotel group.'),
      p('support.sessions.view', 'See support sessions', 'See when platform support signed in as a staff member, and end a session.'),
    ],
  },
];

/** M6: only an owner may manage these by default (managers get them through a custom role). */
const OWNER_ONLY = new Set(['payouts.manage', 'sso.manage', 'data.export']);

export const ALL_PERMISSIONS: readonly string[] = PERMISSION_GROUPS.flatMap((g) => g.permissions.map((x) => x.code));
const ALL_SET = new Set(ALL_PERMISSIONS);

export function isPermission(code: string): boolean {
  return ALL_SET.has(code);
}

export type SystemRoleKey = Exclude<StaffRole, 'CUSTOM'>;

const FRONT_DESK = [
  'reservations.view', 'reservations.create', 'reservations.edit', 'reservations.cancel',
  'frontdesk.checkin', 'frontdesk.checkout',
  'folio.view', 'folio.charge', 'folio.discount',
  'payments.take', 'shifts.own',
  'guests.view', 'guests.edit', 'guests.reveal_id',
  'rooms.status', 'housekeeping.view', 'housekeeping.work',
  'maintenance.view', 'maintenance.report',
  'rates.view', 'corporate.view', 'reviews.view',
  // M5
  'pos.view', 'pos.order', 'pos.settle', 'pos.discount', 'minibar.record',
  'inbox.view', 'inbox.reply', 'loyalty.view', 'loyalty.redeem',
  // M7
  'transfers.view', 'transfers.manage',
  // M8
  'concierge.view', 'concierge.work',
];

const ACCOUNTANT = [
  'reservations.view', 'folio.view', 'shifts.view_all', 'guests.view',
  'reports.view', 'reports.financial', 'guard.view', 'audit.view', 'billing.manage',
  'rates.view', 'corporate.view', 'maintenance.view', 'reviews.view',
  // M5
  'pos.view', 'stock.view', 'channels.view', 'pricing.view', 'loyalty.view',
  // M8
  'concierge.view', 'concierge.reports',
];

export interface SystemRoleDef {
  key: SystemRoleKey;
  name: string;
  description: string;
  permissions: readonly string[];
}

/** M6: permissions every built-in role has. */
const EVERY_ROLE = ['support.request'];

/** Built-in roles, in display order. Read-only and not deletable. */
export const SYSTEM_ROLES: SystemRoleDef[] = ([
  { key: 'OWNER', name: 'Owner', description: 'Everything, always. Only an owner can add or change another owner.', permissions: ALL_PERMISSIONS },
  {
    key: 'MANAGER',
    name: 'Manager',
    description: 'Runs the hotel day to day: everything except the payout bank account, single sign-on and the full data export.',
    permissions: ALL_PERMISSIONS.filter((c) => !OWNER_ONLY.has(c)),
  },
  { key: 'FRONT_DESK', name: 'Front desk', description: 'Bookings, check-in and check-out, folios and payments in their own shift.', permissions: FRONT_DESK },
  { key: 'ACCOUNTANT', name: 'Accountant', description: 'Reads the books: folios, shifts, reports, Revenue Guard and the audit trail.', permissions: ACCOUNTANT },
  {
    key: 'HOUSEKEEPING',
    name: 'Housekeeper',
    description: 'Cleans the rooms assigned to them and reports issues.',
    permissions: ['housekeeping.view', 'housekeeping.work', 'maintenance.report', 'minibar.record'],
  },
  {
    key: 'SUPERVISOR',
    name: 'Housekeeping supervisor',
    description: 'Assigns rooms, balances workloads and inspects cleaned rooms.',
    permissions: [
      'housekeeping.view', 'housekeeping.work', 'housekeeping.assign', 'housekeeping.inspect',
      'rooms.status', 'maintenance.view', 'maintenance.report', 'reservations.view', 'minibar.record',
    ],
  },
  {
    key: 'MAINTENANCE',
    name: 'Maintenance technician',
    description: 'Works maintenance tickets and logs generator diesel.',
    permissions: ['maintenance.view', 'maintenance.report', 'maintenance.work', 'housekeeping.view'],
  },
  {
    key: 'WAITER',
    name: 'Waiter / cashier',
    description: 'Takes orders at the POS, sends them to the kitchen or bar and settles bills in their own shift.',
    permissions: ['pos.view', 'pos.order', 'pos.settle', 'kds.view', 'shifts.own', 'payments.take', 'loyalty.view'],
  },
  {
    key: 'KITCHEN',
    name: 'Kitchen / bar',
    description: 'Works the kitchen display: prepares and bumps tickets.',
    permissions: ['kds.view', 'pos.view', 'stock.view'],
  },
  {
    key: 'CONCIERGE',
    name: 'Concierge',
    description: 'Arranges guest requests, sees private requests, keeps the service catalogue and the vendor directory.',
    permissions: [
      'concierge.view', 'concierge.work', 'concierge.discreet', 'concierge.catalogue',
      'reservations.view', 'guests.view', 'folio.view', 'inbox.view', 'inbox.reply', 'transfers.view',
    ],
  },
] as SystemRoleDef[]).map((r) => ({ ...r, permissions: [...new Set([...r.permissions, ...EVERY_ROLE])] }));

const SYSTEM_BY_KEY = new Map(SYSTEM_ROLES.map((r) => [r.key, r]));

export function systemRole(key: string): SystemRoleDef | undefined {
  return SYSTEM_BY_KEY.get(key as SystemRoleKey);
}

export function isSystemRoleKey(key: string): key is SystemRoleKey {
  return SYSTEM_BY_KEY.has(key as SystemRoleKey);
}

/**
 * Effective permissions of a staff member. OWNER always gets the full
 * catalogue; a custom role gets its stored set, filtered to known codes.
 */
export function permissionsFor(role: StaffRole, customPermissions?: readonly string[] | null): Set<string> {
  if (role === 'CUSTOM') return new Set((customPermissions ?? []).filter(isPermission));
  return new Set(systemRole(role)?.permissions ?? []);
}

/** Codes in `wanted` that `held` lacks (for the no-escalation rule). */
export function missingFrom(held: ReadonlySet<string>, wanted: Iterable<string>): string[] {
  const out: string[] = [];
  for (const c of wanted) if (!held.has(c)) out.push(c);
  return [...new Set(out)].sort();
}
