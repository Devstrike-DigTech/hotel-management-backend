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
  // M7
  'brand_kit',
  'site_templates_all',
  'site_sections',
  'site_fonts',
  'form_fields_unlimited',
  'form_conditional_logic',
  'paid_extras',
  'form_file_uploads',
] as const;

export type FeatureCode = (typeof FEATURE_CODES)[number];

export const LIMIT_CODES = ['max_rooms', 'max_staff', 'max_properties'] as const;
/** M7: checked by the booking form service itself (usage = fields of the draft form). */
export const FORM_FIELD_LIMIT = 'max_custom_form_fields';
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
