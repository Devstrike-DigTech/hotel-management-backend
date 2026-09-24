export const FEATURE_CODES = [
  'front_desk',
  'reservations',
  'guest_register',
  'invoicing',
  'hourly_bookings',
  'offline_mode',
  'marketplace_listing',
  'booking_site_branding',
  'custom_domain',
  'white_label',
  'revenue_guard_basic',
  'revenue_guard_full',
  'owner_whatsapp_alerts',
  'housekeeping',
  'maintenance',
  'custom_roles',
  'audit_export',
  'promotions',
  'pos',
  'channel_manager',
  'dynamic_pricing',
  'whatsapp_messaging',
  'sms_messaging',
  'loyalty',
  'multi_property',
  'api_access',
  'dedicated_database',
  // M6
  'sso',
  'data_export',
] as const;

export type FeatureCode = (typeof FEATURE_CODES)[number];

export const LIMIT_CODES = ['max_rooms', 'max_staff', 'max_properties'] as const;
export type LimitCode = (typeof LIMIT_CODES)[number];

/** Which usage counter each limit is measured against. */
export const LIMIT_USAGE_KEY: Record<LimitCode, keyof Usage> = {
  max_rooms: 'rooms',
  max_staff: 'staff',
  max_properties: 'properties',
};

export const UNLIMITED = -1;

export interface Usage {
  rooms: number;
  staff: number;
  properties: number;
}
