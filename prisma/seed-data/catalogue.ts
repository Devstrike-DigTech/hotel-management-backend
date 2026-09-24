/** Feature catalogue and plans (brief section "Plans"). */

export interface FeatureSeed {
  code: string;
  name: string;
  description: string;
  category: 'Operations' | 'Revenue' | 'Guests' | 'Growth' | 'Platform';
}

export const FEATURES: FeatureSeed[] = [
  { code: 'front_desk', name: 'Front desk', category: 'Operations', description: 'Check guests in and out, assign rooms and see the day at a glance.' },
  { code: 'reservations', name: 'Reservations', category: 'Operations', description: 'Take, modify and cancel bookings from walk-ins, phone and the web.' },
  { code: 'guest_register', name: 'Guest register', category: 'Guests', description: 'A digital guest register with ID capture that replaces the paper book.' },
  { code: 'invoicing', name: 'Invoicing and receipts', category: 'Revenue', description: 'Folios, invoices and receipts with VAT, in naira.' },
  { code: 'hourly_bookings', name: 'Hourly stays', category: 'Revenue', description: 'Sell rooms by the hour with their own rates and turnaround rules.' },
  { code: 'offline_mode', name: 'Offline mode', category: 'Operations', description: 'Keep the front desk running through network outages and sync later.' },
  { code: 'marketplace_listing', name: 'Marketplace listing', category: 'Growth', description: 'Appear on the public marketplace and take direct bookings.' },
  { code: 'booking_site_branding', name: 'Branded booking site', category: 'Growth', description: 'Your logo and colours on your own booking microsite.' },
  { code: 'custom_domain', name: 'Custom domain', category: 'Growth', description: 'Serve your booking site from your own domain name.' },
  { code: 'white_label', name: 'White label', category: 'Platform', description: 'Remove platform branding from every guest-facing surface.' },
  { code: 'revenue_guard_basic', name: 'Revenue Guard (basic)', category: 'Revenue', description: 'Daily reconciliation of room nights against payments received.' },
  { code: 'revenue_guard_full', name: 'Revenue Guard (full)', category: 'Revenue', description: 'Leak detection across rooms, discounts, voids and staff activity.' },
  { code: 'owner_whatsapp_alerts', name: 'Owner WhatsApp alerts', category: 'Revenue', description: 'Nightly takings and anomalies sent to the owner on WhatsApp.' },
  { code: 'housekeeping', name: 'Housekeeping', category: 'Operations', description: 'Cleaning boards, task assignment and room inspection.' },
  { code: 'maintenance', name: 'Maintenance', category: 'Operations', description: 'Log faults, track repairs and keep rooms out of order only as long as needed.' },
  { code: 'custom_roles', name: 'Custom roles', category: 'Platform', description: 'Fine-grained permissions for every member of staff.' },
  { code: 'audit_export', name: 'Audit export', category: 'Platform', description: 'Export the full audit trail for accountants and auditors.' },
  { code: 'promotions', name: 'Promotions', category: 'Growth', description: 'Promo codes, seasonal rates and length-of-stay offers.' },
  { code: 'pos', name: 'Point of sale', category: 'Revenue', description: 'Bar, restaurant and minibar sales posted straight to the guest folio.' },
  { code: 'channel_manager', name: 'Channel manager', category: 'Growth', description: 'Sync rates and availability with online travel agencies.' },
  { code: 'dynamic_pricing', name: 'Dynamic pricing', category: 'Revenue', description: 'Rates that respond to occupancy, events and seasonality.' },
  { code: 'whatsapp_messaging', name: 'WhatsApp messaging', category: 'Guests', description: 'Confirmations, directions and receipts sent to guests on WhatsApp.' },
  { code: 'sms_messaging', name: 'SMS messaging', category: 'Guests', description: 'Booking confirmations and reminders by SMS.' },
  { code: 'loyalty', name: 'Loyalty', category: 'Guests', description: 'Reward returning guests with points and member rates.' },
  { code: 'multi_property', name: 'Multi-property', category: 'Platform', description: 'Run several hotels from one account with shared reporting.' },
  { code: 'api_access', name: 'API access', category: 'Platform', description: 'Programmatic access for your own integrations.' },
  { code: 'dedicated_database', name: 'Dedicated database', category: 'Platform', description: 'Your data in an isolated database instance.' },
  { code: 'sso', name: 'Single sign-on', category: 'Platform', description: 'Staff sign in with Google Workspace, Microsoft Entra ID or any OIDC provider.' },
  { code: 'data_export', name: 'Full data export', category: 'Platform', description: 'Download every record of your hotel group as JSON and CSV, any time.' },
];

const STARTER = [
  'front_desk', 'reservations', 'guest_register', 'invoicing', 'hourly_bookings',
  'offline_mode', 'marketplace_listing', 'revenue_guard_basic',
];
const GROWTH = [
  ...STARTER,
  'booking_site_branding', 'revenue_guard_full', 'owner_whatsapp_alerts',
  'housekeeping', 'maintenance', 'custom_roles', 'promotions', 'sms_messaging',
];
const PRO = [
  ...GROWTH,
  'custom_domain', 'pos', 'channel_manager', 'dynamic_pricing',
  'whatsapp_messaging', 'loyalty', 'multi_property', 'audit_export',
];
const ENTERPRISE = [...PRO, 'white_label', 'api_access', 'dedicated_database', 'sso', 'data_export'];

export interface PlanSeed {
  code: string;
  name: string;
  tagline: string;
  priceMonthlyKobo: number | null;
  priceYearlyKobo: number | null;
  limits: { max_rooms: number; max_staff: number; max_properties: number };
  commissionBps: number | null;
  highlighted: boolean;
  sortOrder: number;
  features: string[];
}

const NAIRA = 100;

export const PLANS: PlanSeed[] = [
  {
    code: 'starter',
    name: 'Starter',
    tagline: 'Everything a small guest house needs to leave the paper register behind.',
    priceMonthlyKobo: 25_000 * NAIRA,
    priceYearlyKobo: 250_000 * NAIRA,
    limits: { max_rooms: 20, max_staff: 3, max_properties: 1 },
    commissionBps: 1000,
    highlighted: false,
    sortOrder: 1,
    features: STARTER,
  },
  {
    code: 'growth',
    name: 'Growth',
    tagline: 'For busy hotels that want tighter control of revenue and a branded booking site.',
    priceMonthlyKobo: 75_000 * NAIRA,
    priceYearlyKobo: 750_000 * NAIRA,
    limits: { max_rooms: 60, max_staff: 15, max_properties: 1 },
    commissionBps: 800,
    highlighted: true,
    sortOrder: 2,
    features: GROWTH,
  },
  {
    code: 'pro',
    name: 'Pro',
    tagline: 'Point of sale, channel manager and dynamic pricing for full-service hotels.',
    priceMonthlyKobo: 180_000 * NAIRA,
    priceYearlyKobo: 1_800_000 * NAIRA,
    limits: { max_rooms: 200, max_staff: 50, max_properties: 3 },
    commissionBps: 500,
    highlighted: false,
    sortOrder: 3,
    features: PRO,
  },
  {
    code: 'enterprise',
    name: 'Enterprise',
    tagline: 'Groups and chains: white label, API access and a dedicated database.',
    priceMonthlyKobo: null,
    priceYearlyKobo: null,
    limits: { max_rooms: -1, max_staff: -1, max_properties: -1 },
    commissionBps: null,
    highlighted: false,
    sortOrder: 4,
    features: ENTERPRISE,
  },
];
