/**
 * Booking form catalogue (M7): the compulsory SYSTEM fields, the two
 * recommended fields, the one-click library and the presets per hotel type.
 */
import type { TemplateId } from '../site/site.registry.js';

export const FIELD_TYPES = [
  'SHORT_TEXT', 'LONG_TEXT', 'NUMBER', 'DATE', 'TIME', 'SELECT', 'MULTI_SELECT', 'YES_NO', 'CHECKBOX', 'PHONE', 'EMAIL', 'FILE', 'EXTRA', 'PICKUP',
] as const;
export type FieldType = (typeof FIELD_TYPES)[number];
export type FieldSource = 'SYSTEM' | 'LIBRARY' | 'CUSTOM';
export type RequiredMode = 'REQUIRED' | 'OPTIONAL' | 'HIDDEN';
export const CHANNELS = ['MARKETPLACE', 'BOOKING_SITE', 'FRONT_DESK'] as const;
export type Channel = (typeof CHANNELS)[number];
export const OPERATORS = ['EQUALS', 'NOT_EQUALS', 'IN', 'IS_TRUE', 'IS_FALSE', 'NOT_EMPTY'] as const;
export type ConditionOperator = (typeof OPERATORS)[number];
export const EXTRA_CATEGORIES = ['TRANSPORT', 'FOOD', 'EARLY_LATE', 'CELEBRATION', 'WELLNESS', 'OTHER'] as const;
export type ExtraCategoryCode = (typeof EXTRA_CATEGORIES)[number];

export interface FieldCondition {
  fieldKey: string;
  operator: ConditionOperator;
  value?: string | number | boolean | string[];
}

export interface FormField {
  key: string;
  source: FieldSource;
  libraryKey: string | null;
  recommended: boolean;
  type: FieldType;
  label: string;
  helpText: string | null;
  placeholder: string | null;
  required: RequiredMode;
  options: { value: string; label: string }[];
  validation: { min?: number; max?: number; pattern?: string; maxLength?: number; maxFileMB?: number; accept?: string[] };
  section: string;
  order: number;
  channels: Channel[];
  condition: FieldCondition | null;
  purpose: string | null;
  guestPurpose: string | null;
  sensitive: boolean;
  extra?: { categories: ExtraCategoryCode[] | null } | null;
  pickup?: { directions: ('ARRIVAL' | 'DEPARTURE')[]; pickupPointIds: string[] | null } | null;
  // Server-computed.
  locked?: { remove: boolean; hide: boolean; type: boolean; channels: boolean };
  mapsTo?: string | null;
  boundTo?: 'QUOTE' | 'GUEST' | 'CONSENT' | null;
  idLike?: { kind: string } | null;
}

export const ALL_CHANNELS: Channel[] = [...CHANNELS];
const ONLINE: Channel[] = ['MARKETPLACE', 'BOOKING_SITE'];

export const SECTIONS = { ABOUT: 'About you', STAY: 'Your stay', GETTING_HERE: 'Getting here', EXTRAS: 'Extras' } as const;

function field(f: Partial<FormField> & Pick<FormField, 'key' | 'type' | 'label' | 'section'>): FormField {
  return {
    source: 'LIBRARY',
    libraryKey: null,
    recommended: false,
    helpText: null,
    placeholder: null,
    required: 'OPTIONAL',
    options: [],
    validation: {},
    order: 0,
    channels: [...ALL_CHANNELS],
    condition: null,
    purpose: null,
    guestPurpose: null,
    sensitive: false,
    ...f,
  };
}

const opt = (...pairs: [string, string][]) => pairs.map(([value, label]) => ({ value, label }));

// ---------------------------------------------------------------------------
// SYSTEM
// ---------------------------------------------------------------------------

export const SYSTEM_FIELDS: FormField[] = [
  field({ key: 'fullName', source: 'SYSTEM', type: 'SHORT_TEXT', label: 'Full name', section: SECTIONS.ABOUT, required: 'REQUIRED', placeholder: 'As it appears on your ID', validation: { maxLength: 120 }, purpose: 'Identifies the guest on the booking and the register card.' }),
  field({ key: 'phone', source: 'SYSTEM', type: 'PHONE', label: 'Phone number', section: SECTIONS.ABOUT, required: 'REQUIRED', placeholder: '0803 123 4567', helpText: 'We send your confirmation and any updates here.', purpose: 'Confirmation, pickup coordination and contact on the day.' }),
  field({ key: 'email', source: 'SYSTEM', type: 'EMAIL', label: 'Email', section: SECTIONS.ABOUT, required: 'OPTIONAL', placeholder: 'you@example.com', helpText: 'Needed to pay online (for your receipt).', purpose: 'Receipts and the confirmation card.' }),
  field({ key: 'dates', source: 'SYSTEM', type: 'DATE', label: 'Dates', section: SECTIONS.STAY, required: 'REQUIRED', channels: [...ALL_CHANNELS] }),
  field({ key: 'adults', source: 'SYSTEM', type: 'NUMBER', label: 'Adults', section: SECTIONS.STAY, required: 'REQUIRED', validation: { min: 1, max: 10 } }),
  field({ key: 'children', source: 'SYSTEM', type: 'NUMBER', label: 'Children', section: SECTIONS.STAY, required: 'OPTIONAL', validation: { min: 0, max: 10 } }),
  field({ key: 'policyConsent', source: 'SYSTEM', type: 'CHECKBOX', label: 'I agree to the hotel policies and the processing of my data for this booking', section: SECTIONS.STAY, required: 'REQUIRED', channels: [...ONLINE], purpose: 'NDPA processing consent.' }),
];

export const SYSTEM_KEYS = new Set(SYSTEM_FIELDS.map((f) => f.key));
/** Where each SYSTEM value comes from (never from `answers`). */
export const SYSTEM_BOUND: Record<string, 'QUOTE' | 'GUEST' | 'CONSENT'> = {
  fullName: 'GUEST', phone: 'GUEST', email: 'GUEST', dates: 'QUOTE', adults: 'QUOTE', children: 'QUOTE', policyConsent: 'CONSENT',
};

// ---------------------------------------------------------------------------
// RECOMMENDED and LIBRARY
// ---------------------------------------------------------------------------

export const RECOMMENDED_FIELDS: FormField[] = [
  field({ key: 'estimatedArrivalTime', libraryKey: 'estimatedArrivalTime', recommended: true, type: 'TIME', label: 'Estimated arrival time', section: SECTIONS.STAY, helpText: 'So we can have your room ready.', guestPurpose: 'Helps the team prepare your room.' }),
  field({ key: 'specialRequests', libraryKey: 'specialRequests', recommended: true, type: 'LONG_TEXT', label: 'Special requests', section: SECTIONS.STAY, placeholder: 'A quiet room, an extra pillow, a cot...', validation: { maxLength: 500 } }),
];

export interface LibraryItem {
  libraryKey: string;
  name: string;
  description: string;
  feature: string | null;
  fields: FormField[];
}

export const NATIONALITIES = [
  'Nigerian', 'Ghanaian', 'Beninese', 'Togolese', 'Cameroonian', 'Ivorian', 'Senegalese', 'Kenyan', 'South African',
  'British', 'American', 'Canadian', 'Chinese', 'Indian', 'Lebanese', 'Other',
];

export const LIBRARY: LibraryItem[] = [
  { libraryKey: 'nationality', name: 'Nationality', description: 'Pre-fills the register card.', feature: null, fields: [
    field({ key: 'nationality', libraryKey: 'nationality', type: 'SELECT', label: 'Nationality', section: SECTIONS.ABOUT, options: NATIONALITIES.map((n) => ({ value: n, label: n })), purpose: 'Guest register (police / security book).' }),
  ] },
  { libraryKey: 'purposeOfVisit', name: 'Purpose of visit', description: 'Business, leisure, event, transit.', feature: null, fields: [
    field({ key: 'purposeOfVisit', libraryKey: 'purposeOfVisit', type: 'SELECT', label: 'Purpose of visit', section: SECTIONS.STAY, options: opt(['BUSINESS', 'Business'], ['LEISURE', 'Leisure'], ['EVENT', 'Event or wedding'], ['TRANSIT', 'Passing through'], ['OTHER', 'Other']), purpose: 'Guest register.' }),
  ] },
  { libraryKey: 'childrenAges', name: "Children's ages", description: 'Shown only when children are booked.', feature: null, fields: [
    field({ key: 'childrenAges', libraryKey: 'childrenAges', type: 'SHORT_TEXT', label: "Children's ages", section: SECTIONS.STAY, placeholder: 'e.g. 4, 9', helpText: 'So we can prepare cots and extra beds.', validation: { maxLength: 60, pattern: '^\\s*\\d{1,2}(?:\\s?,\\s?\\d{1,2}){0,9}\\s*$' }, condition: { fieldKey: 'children', operator: 'NOT_EMPTY' } }),
  ] },
  { libraryKey: 'dateOfBirth', name: 'Date of birth', description: 'Sensitive: only ask if you need it.', feature: null, fields: [
    field({ key: 'dateOfBirth', libraryKey: 'dateOfBirth', type: 'DATE', label: 'Date of birth', section: SECTIONS.ABOUT, sensitive: true, validation: { min: -36_500, max: -1 }, purpose: 'Age checks and birthday courtesies.' }),
  ] },
  { libraryKey: 'homeAddress', name: 'Home address', description: 'Sensitive: pre-fills the register card.', feature: null, fields: [
    field({ key: 'homeAddress', libraryKey: 'homeAddress', type: 'LONG_TEXT', label: 'Home address', section: SECTIONS.ABOUT, sensitive: true, validation: { maxLength: 300 }, purpose: 'Guest register.' }),
  ] },
  { libraryKey: 'nextOfKin', name: 'Next of kin / emergency contact', description: 'Name, phone and relationship.', feature: null, fields: [
    field({ key: 'nextOfKinName', libraryKey: 'nextOfKin', type: 'SHORT_TEXT', label: 'Emergency contact name', section: SECTIONS.ABOUT, sensitive: true, validation: { maxLength: 120 }, purpose: 'Who to call in an emergency.' }),
    field({ key: 'nextOfKinPhone', libraryKey: 'nextOfKin', type: 'PHONE', label: 'Emergency contact phone', section: SECTIONS.ABOUT, sensitive: true, purpose: 'Who to call in an emergency.' }),
    field({ key: 'nextOfKinRelationship', libraryKey: 'nextOfKin', type: 'SELECT', label: 'Relationship', section: SECTIONS.ABOUT, sensitive: true, options: opt(['SPOUSE', 'Spouse'], ['PARENT', 'Parent'], ['SIBLING', 'Brother or sister'], ['CHILD', 'Son or daughter'], ['FRIEND', 'Friend'], ['COLLEAGUE', 'Colleague'], ['OTHER', 'Other']) }),
  ] },
  { libraryKey: 'vehiclePlate', name: 'Vehicle plate number', description: 'For the car park and the register.', feature: null, fields: [
    field({ key: 'vehiclePlate', libraryKey: 'vehiclePlate', type: 'SHORT_TEXT', label: 'Vehicle plate number', section: SECTIONS.GETTING_HERE, placeholder: 'e.g. LSD 482 KJ', validation: { maxLength: 20, pattern: '^[A-Za-z0-9 -]{4,20}$' }, purpose: 'Car park and guest register.' }),
  ] },
  { libraryKey: 'bedPreference', name: 'Bed preference', description: 'King, twin or no preference.', feature: null, fields: [
    field({ key: 'bedPreference', libraryKey: 'bedPreference', type: 'SELECT', label: 'Bed preference', section: SECTIONS.STAY, options: opt(['KING', 'One large bed'], ['TWIN', 'Two single beds'], ['NO_PREFERENCE', 'No preference']) }),
  ] },
  { libraryKey: 'dietary', name: 'Dietary requirements', description: 'Allergies and preferences for breakfast and the kitchen.', feature: null, fields: [
    field({ key: 'dietaryRequirements', libraryKey: 'dietary', type: 'MULTI_SELECT', label: 'Dietary requirements', section: SECTIONS.STAY, options: opt(['VEGETARIAN', 'Vegetarian'], ['VEGAN', 'Vegan'], ['HALAL', 'Halal'], ['NO_PORK', 'No pork'], ['NUT_ALLERGY', 'Nut allergy'], ['GLUTEN_FREE', 'Gluten free'], ['OTHER', 'Other (tell us in special requests)']) }),
  ] },
  { libraryKey: 'company', name: 'Company name and TIN', description: 'Printed on the invoice when filled.', feature: null, fields: [
    field({ key: 'companyName', libraryKey: 'company', type: 'SHORT_TEXT', label: 'Company name (for the invoice)', section: SECTIONS.ABOUT, validation: { maxLength: 120 }, purpose: 'Company invoices.' }),
    field({ key: 'companyTin', libraryKey: 'company', type: 'SHORT_TEXT', label: 'Company TIN', section: SECTIONS.ABOUT, placeholder: 'e.g. 12345678-0001', validation: { maxLength: 20, pattern: '^(\\d{8}-\\d{4}|\\d{10,14})$' }, condition: { fieldKey: 'companyName', operator: 'NOT_EMPTY' }, purpose: 'Company invoices (FIRS tax identification number).' }),
  ] },
  { libraryKey: 'howDidYouHear', name: 'How did you hear about us', description: 'Marketing attribution.', feature: null, fields: [
    field({ key: 'howDidYouHear', libraryKey: 'howDidYouHear', type: 'SELECT', label: 'How did you hear about us?', section: SECTIONS.STAY, options: opt(['INSTAGRAM', 'Instagram'], ['FACEBOOK', 'Facebook'], ['GOOGLE', 'Google'], ['FRIEND', 'A friend or family'], ['RETURNING_GUEST', 'I have stayed before'], ['TRAVEL_AGENT', 'Travel agent'], ['OTHER', 'Other']) }),
  ] },
  { libraryKey: 'marketingConsent', name: 'Marketing consent', description: 'Unticked by default (NDPA).', feature: null, fields: [
    field({ key: 'marketingConsent', libraryKey: 'marketingConsent', type: 'CHECKBOX', label: 'Send me offers and news from the hotel', section: SECTIONS.STAY, channels: [...ONLINE], purpose: 'Marketing (opt-in, unticked by default).' }),
  ] },
  { libraryKey: 'pickup', name: 'Arrival pickup and departure drop-off', description: 'Airports, motor parks, train stations and jetties, priced per pickup point.', feature: 'paid_extras', fields: [
    field({ key: 'arrivalPickup', libraryKey: 'pickup', type: 'PICKUP', label: 'Airport or motor-park pickup', section: SECTIONS.GETTING_HERE, helpText: 'We can meet you at the airport, motor park, train station or jetty.', channels: [...ALL_CHANNELS], pickup: { directions: ['ARRIVAL', 'DEPARTURE'], pickupPointIds: null } }),
  ] },
  { libraryKey: 'extras', name: 'Paid extras', description: 'Breakfast, early check-in, celebrations and more, priced in the booking.', feature: 'paid_extras', fields: [
    field({ key: 'extras', libraryKey: 'extras', type: 'EXTRA', label: 'Add something to your stay', section: SECTIONS.EXTRAS, extra: { categories: null } }),
  ] },
];

/** What each library / recommended key pre-fills (guest profile, register card, reservation). */
export const MAPS_TO: Record<string, string> = {
  estimatedArrivalTime: 'reservation.expectedArrivalTime',
  specialRequests: 'reservation.specialRequests',
  nationality: 'guest.nationality',
  purposeOfVisit: 'registration.purpose',
  dateOfBirth: 'guest.dateOfBirth',
  homeAddress: 'guest.address',
  vehiclePlate: 'guest.vehiclePlate',
  companyName: 'guest.company',
  companyTin: 'invoice.billTo.tin',
  marketingConsent: 'guest.marketingOptIn',
  arrivalPickup: 'transfers',
  extras: 'reservation.extras',
};

export const LIBRARY_FIELD_BY_KEY = new Map<string, FormField>([...RECOMMENDED_FIELDS, ...LIBRARY.flatMap((l) => l.fields)].map((f) => [f.key, f]));

// ---------------------------------------------------------------------------
// Presets
// ---------------------------------------------------------------------------

export const PRESET_IDS = ['default', 'guesthouse', 'business', 'resort', 'boutique', 'serviced_apartments', 'event_venue'] as const;
export type PresetId = (typeof PRESET_IDS)[number];

export interface Preset {
  id: PresetId;
  name: string;
  hotelType: string;
  description: string;
  suggestedTemplateId: TemplateId;
  library: string[];
  custom: FormField[];
}

const occasion = field({
  key: 'c_occasion', source: 'CUSTOM', type: 'SELECT', label: 'Is it a special occasion?', section: SECTIONS.STAY,
  options: opt(['BIRTHDAY', 'Birthday'], ['ANNIVERSARY', 'Anniversary'], ['HONEYMOON', 'Honeymoon'], ['PROPOSAL', 'Proposal'], ['BUSINESS', 'Business trip'], ['NONE', 'No, just a stay']),
  channels: [...ONLINE],
  guestPurpose: 'So we can make it memorable.',
});

export const PRESETS: Preset[] = [
  { id: 'default', name: 'Standard', hotelType: 'Any hotel', description: 'The compulsory fields and the two recommended ones. Add more whenever you need them.', suggestedTemplateId: 'editorial', library: [], custom: [] },
  { id: 'guesthouse', name: 'Guesthouse', hotelType: 'Guesthouse', description: 'Short and quick: purpose of visit and the car for the compound.', suggestedTemplateId: 'essentials', library: ['purposeOfVisit', 'vehiclePlate'], custom: [] },
  { id: 'business', name: 'Business hotel', hotelType: 'Business hotel', description: 'Company invoices, airport pickups and the register details corporate guests expect.', suggestedTemplateId: 'business', library: ['purposeOfVisit', 'company', 'pickup', 'nationality'], custom: [] },
  { id: 'resort', name: 'Resort', hotelType: 'Resort', description: 'Families and celebrations: children, dietary needs, extras and pickups.', suggestedTemplateId: 'resort', library: ['childrenAges', 'dietary', 'bedPreference', 'pickup', 'extras'], custom: [occasion] },
  { id: 'boutique', name: 'Boutique', hotelType: 'Boutique hotel', description: 'Personal touches: the occasion, preferences and extras.', suggestedTemplateId: 'boutique', library: ['bedPreference', 'dietary', 'extras', 'howDidYouHear'], custom: [occasion] },
  { id: 'serviced_apartments', name: 'Serviced apartments', hotelType: 'Serviced apartments', description: 'Longer stays: company, car and an emergency contact.', suggestedTemplateId: 'business', library: ['purposeOfVisit', 'company', 'vehiclePlate', 'nextOfKin'], custom: [] },
  {
    id: 'event_venue', name: 'Event and wedding venue', hotelType: 'Event / wedding venue hotel', description: 'Know which event each guest is attending and whose guest they are.', suggestedTemplateId: 'heritage',
    library: ['pickup', 'extras'],
    custom: [
      field({ key: 'c_event_name', source: 'CUSTOM', type: 'SHORT_TEXT', label: 'Which event are you attending?', section: SECTIONS.STAY, placeholder: 'e.g. Adaeze and Tunde\'s wedding', validation: { maxLength: 120 } }),
      field({ key: 'c_guest_of', source: 'CUSTOM', type: 'SELECT', label: 'Guest of', section: SECTIONS.STAY, options: opt(['BRIDE', "Bride's family"], ['GROOM', "Groom's family"], ['CELEBRANT', 'The celebrant'], ['ORGANISER', 'The organisers'], ['OTHER', 'Other']) }),
    ],
  },
];

export function presetById(id: string): Preset | null {
  return PRESETS.find((p) => p.id === id) ?? null;
}

export function libraryItem(key: string): LibraryItem | null {
  return LIBRARY.find((l) => l.libraryKey === key) ?? null;
}
