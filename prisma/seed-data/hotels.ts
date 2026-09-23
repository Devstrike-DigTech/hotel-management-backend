/**
 * Fictional hotels for the marketplace and the demo account.
 * Every name, person, phone number and address here is invented.
 */
import type { RoomStatus, StaffRole, SubscriptionStatus } from '../../src/generated/prisma/enums.js';

const img = (id: string) =>
  `https://images.unsplash.com/photo-${id}?w=1600&q=80`;

/** Unsplash photo ids, grouped by what they show. */
export const PHOTOS = {
  poolNight: img('1566073771259-6a8506099945'),
  exteriorPool: img('1542314831-068cd1dbfeeb'),
  resortPool: img('1551882547-ff40c63fe5fa'),
  palmPool: img('1520250497591-112f2f40a3f4'),
  rooftopPool: img('1571896349842-33c89424de2d'),
  villaPool: img('1584132967334-10e028bd69f7'),
  loungerPool: img('1540541338287-41700207dee6'),
  sunnyPool: img('1571003123894-1f0594d2b5d9'),
  facade: img('1445019980597-93fa8acb246c'),
  lobby: img('1564501049412-61c2a3083791'),
  lobbyLounge: img('1455587734955-081b22074882'),
  lobbyWarm: img('1517840901100-8179e982acb7'),
  restaurant: img('1414235077428-338989a2e8c0'),
  spa: img('1544161515-4ab6ce6db874'),
  bathroom: img('1584622650111-993a426fbf0a'),
  roomWhite: img('1582719478250-c89cae4dc85b'),
  roomKing: img('1590490360182-c33d57733427'),
  roomTwin: img('1611892440504-42a792e24d32'),
  roomSoft: img('1618773928121-c32242e63f39'),
  roomModern: img('1631049307264-da0ec9d70304'),
  roomBright: img('1596394516093-501ba68a0ba6'),
  roomSuite: img('1578683010236-d716f9a3f461'),
  roomClassic: img('1566665797739-1674de7a421a'),
  roomView: img('1522798514-97ceb8c4f1c8'),
  roomCosy: img('1560347876-aeef00ee58a1'),
  roomWarm: img('1595576508898-0ad5c879a061'),
  roomQueen: img('1568495248636-6432b97bd949'),
  roomMinimal: img('1540518614846-7eded433c457'),
  roomLinen: img('1505693416388-ac5ce068fe85'),
  roomDesk: img('1591088398332-8a7791972843'),
} as const;

export interface RoomTypeSeed {
  name: string;
  description: string;
  basePriceNaira: number;
  hourlyPriceNaira?: number;
  capacity: number;
  bedType: string;
  sizeSqm: number;
  amenities: string[];
  images: { url: string; alt: string }[];
}

export interface RoomSeed {
  number: string;
  floor: number;
  type: string; // room type name
  status: RoomStatus;
  notes?: string;
}

export interface StaffSeed {
  fullName: string;
  email: string;
  phone: string;
  role: StaffRole;
}

export interface HotelSeed {
  slug: string;
  name: string;
  tagline: string;
  description: string;
  city: string;
  state: string;
  area: string;
  address: string;
  phone: string;
  email: string;
  checkInTime: string;
  checkOutTime: string;
  coverImageUrl: string;
  images: { url: string; alt: string }[];
  amenities: string[];
  policies: string[];
  accentColor: string | null;
  featured: boolean;
  rating: number | null;
  reviewCount: number;
  plan: 'starter' | 'growth' | 'pro' | 'enterprise';
  status: SubscriptionStatus;
  interval: 'MONTHLY' | 'YEARLY';
  /** Days relative to now; negative = in the past. */
  trialEndsInDays?: number;
  periodEndsInDays?: number;
  createdDaysAgo: number;
  owner: StaffSeed;
  staff: StaffSeed[];
  roomTypes: RoomTypeSeed[];
  rooms: RoomSeed[];
}

const STANDARD_POLICIES = [
  'Check-in from 2:00 PM; check-out by 12:00 noon.',
  'A valid government-issued photo ID is required at check-in.',
  'Smoking is not permitted in rooms; designated areas are available.',
  'Pets are not allowed.',
  'Children under 12 stay free when using existing bedding.',
];

/** Spread `count` rooms over floors with a realistic status mix. */
function roomsFor(
  plan: { floor: number; from: number; count: number; type: string }[],
  statuses: RoomStatus[],
): RoomSeed[] {
  const out: RoomSeed[] = [];
  let i = 0;
  for (const block of plan) {
    for (let n = 0; n < block.count; n++) {
      out.push({
        number: String(block.from + n),
        floor: block.floor,
        type: block.type,
        status: statuses[i % statuses.length],
      });
      i++;
    }
  }
  return out;
}

const MIX: RoomStatus[] = [
  'OCCUPIED',
  'VACANT_CLEAN',
  'OCCUPIED',
  'VACANT_DIRTY',
  'VACANT_CLEAN',
  'OCCUPIED',
  'RESERVED',
  'VACANT_CLEAN',
];

// -----------------------------------------------------------------------------
// Demo hotel: The Palmwine House (Growth, ACTIVE). 3 room types, 24 rooms on
// floors 1-3, 5 staff accounts (owner + 4).
// -----------------------------------------------------------------------------
export const DEMO_HOTEL: HotelSeed = {
  slug: 'palmwine-house',
  name: 'The Palmwine House',
  tagline: 'A slow, green courtyard hotel a short walk from the Lekki waterfront.',
  description:
    'The Palmwine House is a 24-room boutique hotel set around a planted courtyard in Lekki Phase 1. ' +
    'Rooms are finished in local hardwoods and hand-dyed adire textiles, the kitchen serves a Nigerian breakfast ' +
    'until 11, and the rooftop bar pours palm wine from a family tapper in Epe every evening. ' +
    'Power is uninterrupted, the Wi-Fi is fast enough for video calls, and Admiralty Way is five minutes away.',
  city: 'Lagos',
  state: 'Lagos',
  area: 'Lekki Phase 1',
  address: '14 Fola Osibo Road, Lekki Phase 1, Lagos',
  phone: '+234 802 555 0141',
  email: 'stay@palmwine.ng',
  checkInTime: '14:00',
  checkOutTime: '12:00',
  coverImageUrl: PHOTOS.palmPool,
  images: [
    { url: PHOTOS.palmPool, alt: 'Courtyard pool framed by palms' },
    { url: PHOTOS.lobbyWarm, alt: 'Reception with timber panelling' },
    { url: PHOTOS.roomKing, alt: 'Deluxe King room' },
    { url: PHOTOS.restaurant, alt: 'Breakfast room' },
  ],
  amenities: [
    'Free Wi-Fi',
    '24-hour power',
    'Swimming pool',
    'Rooftop bar',
    'Restaurant',
    'Secure parking',
    'Airport pickup',
    'Laundry',
  ],
  policies: STANDARD_POLICIES,
  accentColor: '#B4452A',
  featured: true,
  rating: 4.7,
  reviewCount: 312,
  plan: 'growth',
  status: 'ACTIVE',
  interval: 'MONTHLY',
  periodEndsInDays: 20,
  createdDaysAgo: 160,
  owner: {
    fullName: 'Adaeze Okafor',
    email: 'demo@palmwine.ng',
    phone: '+234 803 555 0100',
    role: 'OWNER',
  },
  staff: [
    { fullName: 'Tunde Bakare', email: 'tunde@palmwine.ng', phone: '+234 805 555 0102', role: 'MANAGER' },
    { fullName: 'Ngozi Eze', email: 'ngozi@palmwine.ng', phone: '+234 806 555 0103', role: 'FRONT_DESK' },
    { fullName: 'Chidinma Obi', email: 'chidinma@palmwine.ng', phone: '+234 809 555 0106', role: 'FRONT_DESK' },
    { fullName: 'Musa Abdullahi', email: 'musa@palmwine.ng', phone: '+234 807 555 0104', role: 'HOUSEKEEPING' },
    { fullName: 'Funmilayo Adeyemi', email: 'funmi@palmwine.ng', phone: '+234 808 555 0105', role: 'ACCOUNTANT' },
  ],
  roomTypes: [
    {
      name: 'Standard Queen',
      description: 'A calm queen room overlooking the courtyard, with a rain shower and a work desk.',
      basePriceNaira: 55_000,
      hourlyPriceNaira: 15_000,
      capacity: 2,
      bedType: 'Queen',
      sizeSqm: 22,
      amenities: ['Air conditioning', 'Smart TV', 'Rain shower', 'Work desk', 'Free Wi-Fi'],
      images: [
        { url: PHOTOS.roomQueen, alt: 'Standard Queen room' },
        { url: PHOTOS.bathroom, alt: 'Rain shower bathroom' },
      ],
    },
    {
      name: 'Deluxe King',
      description: 'A larger corner room with a king bed, reading chair and a balcony over the palms.',
      basePriceNaira: 85_000,
      hourlyPriceNaira: 25_000,
      capacity: 2,
      bedType: 'King',
      sizeSqm: 30,
      amenities: ['Air conditioning', 'Balcony', 'Minibar', 'Smart TV', 'Rain shower', 'Free Wi-Fi'],
      images: [
        { url: PHOTOS.roomKing, alt: 'Deluxe King room' },
        { url: PHOTOS.roomLinen, alt: 'King bed with fresh linen' },
      ],
    },
    {
      name: 'Palm Suite',
      description: 'A top-floor suite with a separate lounge, soaking tub and a private terrace.',
      basePriceNaira: 160_000,
      capacity: 3,
      bedType: 'King + sofa bed',
      sizeSqm: 48,
      amenities: ['Air conditioning', 'Private terrace', 'Soaking tub', 'Lounge', 'Minibar', 'Nespresso machine', 'Free Wi-Fi'],
      images: [
        { url: PHOTOS.roomSuite, alt: 'Palm Suite lounge' },
        { url: PHOTOS.spa, alt: 'Suite bathroom' },
      ],
    },
  ],
  rooms: [
    // Floor 1: Standard Queen 101-108
    { number: '101', floor: 1, type: 'Standard Queen', status: 'OCCUPIED' },
    { number: '102', floor: 1, type: 'Standard Queen', status: 'OCCUPIED' },
    { number: '103', floor: 1, type: 'Standard Queen', status: 'VACANT_CLEAN' },
    { number: '104', floor: 1, type: 'Standard Queen', status: 'VACANT_DIRTY' },
    { number: '105', floor: 1, type: 'Standard Queen', status: 'OCCUPIED' },
    { number: '106', floor: 1, type: 'Standard Queen', status: 'OUT_OF_ORDER', notes: 'AC compressor replacement booked for Thursday' },
    { number: '107', floor: 1, type: 'Standard Queen', status: 'VACANT_CLEAN' },
    { number: '108', floor: 1, type: 'Standard Queen', status: 'OCCUPIED' },
    // Floor 2: Standard Queen 201-204, Deluxe King 205-208
    { number: '201', floor: 2, type: 'Standard Queen', status: 'OCCUPIED' },
    { number: '202', floor: 2, type: 'Standard Queen', status: 'VACANT_DIRTY' },
    { number: '203', floor: 2, type: 'Standard Queen', status: 'RESERVED', notes: 'Late arrival, guest landing 23:40' },
    { number: '204', floor: 2, type: 'Standard Queen', status: 'OCCUPIED' },
    { number: '205', floor: 2, type: 'Deluxe King', status: 'OCCUPIED' },
    { number: '206', floor: 2, type: 'Deluxe King', status: 'VACANT_CLEAN' },
    { number: '207', floor: 2, type: 'Deluxe King', status: 'OCCUPIED' },
    { number: '208', floor: 2, type: 'Deluxe King', status: 'VACANT_DIRTY' },
    // Floor 3: Deluxe King 301-305, Palm Suite 306-308
    { number: '301', floor: 3, type: 'Deluxe King', status: 'OCCUPIED' },
    { number: '302', floor: 3, type: 'Deluxe King', status: 'VACANT_CLEAN' },
    { number: '303', floor: 3, type: 'Deluxe King', status: 'RESERVED' },
    { number: '304', floor: 3, type: 'Deluxe King', status: 'OCCUPIED' },
    { number: '305', floor: 3, type: 'Deluxe King', status: 'VACANT_DIRTY' },
    { number: '306', floor: 3, type: 'Palm Suite', status: 'OCCUPIED' },
    { number: '307', floor: 3, type: 'Palm Suite', status: 'VACANT_CLEAN' },
    { number: '308', floor: 3, type: 'Palm Suite', status: 'VACANT_CLEAN', notes: 'Anniversary setup requested for Saturday' },
  ],
};

// -----------------------------------------------------------------------------
// Marketplace hotels
// -----------------------------------------------------------------------------
export const MARKETPLACE_HOTELS: HotelSeed[] = [
  {
    slug: 'ikoyi-lantern',
    name: 'The Ikoyi Lantern',
    tagline: 'Quiet, tree-lined luxury off Bourdillon, with a lagoon-view pool.',
    description:
      'A 40-key townhouse hotel on a leafy Ikoyi close. Expect generous rooms, a lap pool facing the lagoon, ' +
      'an all-day brasserie and a concierge who can get you a table anywhere on the island.',
    city: 'Lagos',
    state: 'Lagos',
    area: 'Ikoyi',
    address: '7 Glover Road, Ikoyi, Lagos',
    phone: '+234 809 555 0201',
    email: 'reservations@ikoyilantern.ng',
    checkInTime: '15:00',
    checkOutTime: '12:00',
    coverImageUrl: PHOTOS.poolNight,
    images: [
      { url: PHOTOS.poolNight, alt: 'Pool terrace at dusk' },
      { url: PHOTOS.lobby, alt: 'Double-height lobby' },
      { url: PHOTOS.roomSuite, alt: 'Executive Suite' },
      { url: PHOTOS.restaurant, alt: 'Brasserie' },
    ],
    amenities: ['Free Wi-Fi', '24-hour power', 'Swimming pool', 'Gym', 'Spa', 'Restaurant', 'Bar', 'Concierge', 'Airport shuttle'],
    policies: STANDARD_POLICIES,
    accentColor: '#22324F',
    featured: true,
    rating: 4.9,
    reviewCount: 468,
    plan: 'pro',
    status: 'ACTIVE',
    interval: 'YEARLY',
    periodEndsInDays: 210,
    createdDaysAgo: 300,
    owner: { fullName: 'Kemi Adebayo-Cole', email: 'owner@ikoyilantern.ng', phone: '+234 809 555 0200', role: 'OWNER' },
    staff: [{ fullName: 'Chidi Nwosu', email: 'chidi@ikoyilantern.ng', phone: '+234 809 555 0202', role: 'MANAGER' }],
    roomTypes: [
      {
        name: 'Classic King',
        description: 'A serene king room with blackout drapes, a marble bathroom and a garden view.',
        basePriceNaira: 145_000,
        capacity: 2,
        bedType: 'King',
        sizeSqm: 34,
        amenities: ['Air conditioning', 'Marble bathroom', 'Minibar', 'Smart TV', 'Free Wi-Fi'],
        images: [{ url: PHOTOS.roomWhite, alt: 'Classic King room' }],
      },
      {
        name: 'Executive Suite',
        description: 'Separate living room, dining table for four and a lagoon-facing balcony.',
        basePriceNaira: 280_000,
        capacity: 3,
        bedType: 'King',
        sizeSqm: 62,
        amenities: ['Air conditioning', 'Living room', 'Balcony', 'Bathtub', 'Butler service', 'Free Wi-Fi'],
        images: [{ url: PHOTOS.roomSuite, alt: 'Executive Suite living area' }],
      },
      {
        name: 'Lantern Penthouse',
        description: 'The whole top floor: two bedrooms, a private plunge pool and a wraparound terrace.',
        basePriceNaira: 450_000,
        capacity: 4,
        bedType: '2 King',
        sizeSqm: 140,
        amenities: ['Private plunge pool', 'Terrace', 'Kitchen', 'Butler service', 'Free Wi-Fi'],
        images: [{ url: PHOTOS.villaPool, alt: 'Penthouse plunge pool' }],
      },
    ],
    rooms: roomsFor(
      [
        { floor: 1, from: 101, count: 6, type: 'Classic King' },
        { floor: 2, from: 201, count: 6, type: 'Classic King' },
        { floor: 3, from: 301, count: 3, type: 'Executive Suite' },
        { floor: 4, from: 401, count: 1, type: 'Lantern Penthouse' },
      ],
      MIX,
    ),
  },
  {
    slug: 'eko-tides',
    name: 'Eko Tides Hotel',
    tagline: 'Business-ready rooms on Victoria Island with Atlantic sunsets.',
    description:
      'Eko Tides sits between the Adeola Odeku offices and the beach. Rooms are built for work and sleep, ' +
      'the meeting rooms seat up to 80, and the ninth-floor bar has the best sunset on the island.',
    city: 'Lagos',
    state: 'Lagos',
    area: 'Victoria Island',
    address: '22 Adeola Odeku Street, Victoria Island, Lagos',
    phone: '+234 810 555 0301',
    email: 'hello@ekotides.ng',
    checkInTime: '14:00',
    checkOutTime: '12:00',
    coverImageUrl: PHOTOS.rooftopPool,
    images: [
      { url: PHOTOS.rooftopPool, alt: 'Rooftop pool' },
      { url: PHOTOS.lobbyLounge, alt: 'Lobby lounge' },
      { url: PHOTOS.roomView, alt: 'Ocean View Double' },
    ],
    amenities: ['Free Wi-Fi', '24-hour power', 'Swimming pool', 'Gym', 'Conference rooms', 'Restaurant', 'Bar', 'Secure parking'],
    policies: STANDARD_POLICIES,
    accentColor: null,
    featured: false,
    rating: 4.5,
    reviewCount: 291,
    plan: 'growth',
    status: 'ACTIVE',
    interval: 'MONTHLY',
    periodEndsInDays: 12,
    createdDaysAgo: 220,
    owner: { fullName: 'Babajide Olatunji', email: 'owner@ekotides.ng', phone: '+234 810 555 0300', role: 'OWNER' },
    staff: [],
    roomTypes: [
      {
        name: 'Ocean View Double',
        description: 'Two double beds and a full-width window facing the Atlantic.',
        basePriceNaira: 120_000,
        hourlyPriceNaira: 35_000,
        capacity: 4,
        bedType: '2 Double',
        sizeSqm: 32,
        amenities: ['Air conditioning', 'Sea view', 'Smart TV', 'Free Wi-Fi'],
        images: [{ url: PHOTOS.roomView, alt: 'Ocean View Double' }],
      },
      {
        name: 'Business King',
        description: 'A king bed, ergonomic chair and a desk big enough for two screens.',
        basePriceNaira: 150_000,
        capacity: 2,
        bedType: 'King',
        sizeSqm: 30,
        amenities: ['Air conditioning', 'Work desk', 'Espresso machine', 'Free Wi-Fi'],
        images: [{ url: PHOTOS.roomDesk, alt: 'Business King room' }],
      },
      {
        name: 'Tides Suite',
        description: 'Corner suite with a lounge, a bathtub by the window and lounge access.',
        basePriceNaira: 260_000,
        capacity: 3,
        bedType: 'King',
        sizeSqm: 55,
        amenities: ['Air conditioning', 'Lounge access', 'Bathtub', 'Sea view', 'Free Wi-Fi'],
        images: [{ url: PHOTOS.roomSuite, alt: 'Tides Suite' }],
      },
    ],
    rooms: roomsFor(
      [
        { floor: 5, from: 501, count: 6, type: 'Ocean View Double' },
        { floor: 6, from: 601, count: 6, type: 'Business King' },
        { floor: 7, from: 701, count: 2, type: 'Tides Suite' },
      ],
      MIX,
    ),
  },
  {
    slug: 'maitama-court',
    name: 'Maitama Court',
    tagline: 'Diplomatic-quarter calm, a short drive from the Three Arms Zone.',
    description:
      'Maitama Court is a low-rise hotel in landscaped grounds among the embassies. The suites are favoured ' +
      'by visiting delegations; the terrace restaurant serves suya and grills under the neem trees.',
    city: 'Abuja',
    state: 'FCT',
    area: 'Maitama',
    address: '3 Mississippi Street, Maitama, Abuja',
    phone: '+234 811 555 0401',
    email: 'frontoffice@maitamacourt.ng',
    checkInTime: '14:00',
    checkOutTime: '12:00',
    coverImageUrl: PHOTOS.exteriorPool,
    images: [
      { url: PHOTOS.exteriorPool, alt: 'Garden pool' },
      { url: PHOTOS.lobby, alt: 'Reception hall' },
      { url: PHOTOS.roomClassic, alt: 'Deluxe King room' },
      { url: PHOTOS.spa, alt: 'Spa treatment room' },
    ],
    amenities: ['Free Wi-Fi', '24-hour power', 'Swimming pool', 'Spa', 'Gym', 'Conference hall', 'Restaurant', 'Airport shuttle', 'Secure parking'],
    policies: STANDARD_POLICIES,
    accentColor: '#2F5A43',
    featured: true,
    rating: 4.8,
    reviewCount: 377,
    plan: 'enterprise',
    status: 'ACTIVE',
    interval: 'YEARLY',
    periodEndsInDays: 300,
    createdDaysAgo: 340,
    owner: { fullName: 'Hauwa Bello', email: 'owner@maitamacourt.ng', phone: '+234 811 555 0400', role: 'OWNER' },
    staff: [
      { fullName: 'Ibrahim Sani', email: 'ibrahim@maitamacourt.ng', phone: '+234 811 555 0402', role: 'MANAGER' },
      { fullName: 'Grace Okon', email: 'grace@maitamacourt.ng', phone: '+234 811 555 0403', role: 'FRONT_DESK' },
    ],
    roomTypes: [
      {
        name: 'Deluxe King',
        description: 'A spacious king room opening onto the gardens.',
        basePriceNaira: 180_000,
        capacity: 2,
        bedType: 'King',
        sizeSqm: 38,
        amenities: ['Air conditioning', 'Garden view', 'Minibar', 'Smart TV', 'Free Wi-Fi'],
        images: [{ url: PHOTOS.roomClassic, alt: 'Deluxe King room' }],
      },
      {
        name: 'Diplomat Suite',
        description: 'A private study, a lounge for small meetings and a dressing room.',
        basePriceNaira: 380_000,
        capacity: 3,
        bedType: 'King',
        sizeSqm: 80,
        amenities: ['Air conditioning', 'Study', 'Lounge', 'Bathtub', 'Butler service', 'Free Wi-Fi'],
        images: [{ url: PHOTOS.roomSuite, alt: 'Diplomat Suite' }],
      },
      {
        name: 'Garden Villa',
        description: 'A standalone two-bedroom villa with its own pool and kitchen.',
        basePriceNaira: 450_000,
        capacity: 5,
        bedType: 'King + 2 Single',
        sizeSqm: 150,
        amenities: ['Private pool', 'Kitchen', 'Garden', 'Butler service', 'Free Wi-Fi'],
        images: [{ url: PHOTOS.villaPool, alt: 'Garden Villa pool' }],
      },
    ],
    rooms: roomsFor(
      [
        { floor: 1, from: 101, count: 8, type: 'Deluxe King' },
        { floor: 2, from: 201, count: 4, type: 'Diplomat Suite' },
        { floor: 0, from: 1, count: 2, type: 'Garden Villa' },
      ],
      MIX,
    ).map((r) => (r.type === 'Garden Villa' ? { ...r, number: `V${r.number}` } : r)),
  },
  {
    slug: 'wuse-garden-suites',
    name: 'Wuse Garden Suites',
    tagline: 'Clean, bright studios steps from Aminu Kano Crescent.',
    description:
      'A friendly 12-room guest house in the middle of Wuse II. Walk to Banex and the restaurants on ' +
      'Aminu Kano Crescent, then come back to a quiet room with reliable power and a proper breakfast.',
    city: 'Abuja',
    state: 'FCT',
    area: 'Wuse II',
    address: '18 Libreville Crescent, Wuse II, Abuja',
    phone: '+234 812 555 0501',
    email: 'book@wusegarden.ng',
    checkInTime: '13:00',
    checkOutTime: '12:00',
    coverImageUrl: PHOTOS.facade,
    images: [
      { url: PHOTOS.facade, alt: 'Front of the guest house' },
      { url: PHOTOS.roomBright, alt: 'Studio room' },
    ],
    amenities: ['Free Wi-Fi', '24-hour power', 'Breakfast included', 'Secure parking', 'Laundry'],
    policies: STANDARD_POLICIES,
    accentColor: null,
    featured: false,
    rating: 4.3,
    reviewCount: 96,
    plan: 'starter',
    status: 'TRIALING',
    interval: 'MONTHLY',
    trialEndsInDays: 3,
    createdDaysAgo: 11,
    owner: { fullName: 'Emeka Obi', email: 'owner@wusegarden.ng', phone: '+234 812 555 0500', role: 'OWNER' },
    staff: [],
    roomTypes: [
      {
        name: 'Standard Double',
        description: 'A tidy double room with a shower and a writing desk.',
        basePriceNaira: 45_000,
        hourlyPriceNaira: 12_000,
        capacity: 2,
        bedType: 'Double',
        sizeSqm: 18,
        amenities: ['Air conditioning', 'Shower', 'Free Wi-Fi'],
        images: [{ url: PHOTOS.roomCosy, alt: 'Standard Double room' }],
      },
      {
        name: 'Garden Studio',
        description: 'A studio with a kitchenette and a small patio.',
        basePriceNaira: 65_000,
        capacity: 2,
        bedType: 'Queen',
        sizeSqm: 26,
        amenities: ['Air conditioning', 'Kitchenette', 'Patio', 'Free Wi-Fi'],
        images: [{ url: PHOTOS.roomBright, alt: 'Garden Studio' }],
      },
    ],
    rooms: roomsFor(
      [
        { floor: 1, from: 1, count: 6, type: 'Standard Double' },
        { floor: 2, from: 7, count: 4, type: 'Garden Studio' },
      ],
      MIX,
    ),
  },
  {
    slug: 'garden-city-lodge',
    name: 'Garden City Lodge',
    tagline: 'A dependable base in Old GRA for oil-and-gas travellers and families.',
    description:
      'Garden City Lodge has looked after visitors to Port Harcourt for over a decade. Rooms are large, ' +
      'the kitchen does an excellent pepper soup, and the airport transfer desk runs around the clock.',
    city: 'Port Harcourt',
    state: 'Rivers',
    area: 'Old GRA',
    address: '9 Forces Avenue, Old GRA, Port Harcourt',
    phone: '+234 813 555 0601',
    email: 'stay@gardencitylodge.ng',
    checkInTime: '14:00',
    checkOutTime: '12:00',
    coverImageUrl: PHOTOS.sunnyPool,
    images: [
      { url: PHOTOS.sunnyPool, alt: 'Pool deck' },
      { url: PHOTOS.lobbyWarm, alt: 'Reception' },
      { url: PHOTOS.roomTwin, alt: 'Deluxe Twin room' },
    ],
    amenities: ['Free Wi-Fi', '24-hour power', 'Swimming pool', 'Restaurant', 'Bar', 'Airport shuttle', 'Secure parking'],
    policies: STANDARD_POLICIES,
    accentColor: null,
    featured: false,
    rating: 4.4,
    reviewCount: 183,
    plan: 'growth',
    status: 'ACTIVE',
    interval: 'MONTHLY',
    periodEndsInDays: 5,
    createdDaysAgo: 120,
    owner: { fullName: 'Tamuno Briggs', email: 'owner@gardencitylodge.ng', phone: '+234 813 555 0600', role: 'OWNER' },
    staff: [{ fullName: 'Blessing Amadi', email: 'blessing@gardencitylodge.ng', phone: '+234 813 555 0602', role: 'FRONT_DESK' }],
    roomTypes: [
      {
        name: 'Standard Queen',
        description: 'Comfortable queen room with a sitting area.',
        basePriceNaira: 60_000,
        hourlyPriceNaira: 18_000,
        capacity: 2,
        bedType: 'Queen',
        sizeSqm: 24,
        amenities: ['Air conditioning', 'Smart TV', 'Free Wi-Fi'],
        images: [{ url: PHOTOS.roomWarm, alt: 'Standard Queen room' }],
      },
      {
        name: 'Deluxe Twin',
        description: 'Two single beds, ideal for colleagues travelling together.',
        basePriceNaira: 90_000,
        capacity: 2,
        bedType: '2 Single',
        sizeSqm: 28,
        amenities: ['Air conditioning', 'Work desk', 'Minibar', 'Free Wi-Fi'],
        images: [{ url: PHOTOS.roomTwin, alt: 'Deluxe Twin room' }],
      },
      {
        name: 'Family Suite',
        description: 'Two connected rooms with a lounge, sleeping up to four.',
        basePriceNaira: 150_000,
        capacity: 4,
        bedType: 'King + 2 Single',
        sizeSqm: 50,
        amenities: ['Air conditioning', 'Lounge', 'Two bathrooms', 'Free Wi-Fi'],
        images: [{ url: PHOTOS.roomSoft, alt: 'Family Suite' }],
      },
    ],
    rooms: roomsFor(
      [
        { floor: 1, from: 101, count: 6, type: 'Standard Queen' },
        { floor: 2, from: 201, count: 5, type: 'Deluxe Twin' },
        { floor: 3, from: 301, count: 2, type: 'Family Suite' },
      ],
      MIX,
    ),
  },
  {
    slug: 'marina-creek',
    name: 'Marina Creek Hotel',
    tagline: 'Creekside rooms in Calabar, ten minutes from the Carnival route.',
    description:
      'A relaxed hotel on the Calabar waterfront with a garden bar, a small pool and rooms that catch the ' +
      'river breeze. Ask the front desk about boat trips and the drill ranch.',
    city: 'Calabar',
    state: 'Cross River',
    area: 'Marina',
    address: '5 Marina Road, Calabar',
    phone: '+234 814 555 0701',
    email: 'hello@marinacreek.ng',
    checkInTime: '14:00',
    checkOutTime: '11:00',
    coverImageUrl: PHOTOS.loungerPool,
    images: [
      { url: PHOTOS.loungerPool, alt: 'Pool with loungers' },
      { url: PHOTOS.roomMinimal, alt: 'Creekside Deluxe room' },
    ],
    amenities: ['Free Wi-Fi', '24-hour power', 'Swimming pool', 'Garden bar', 'Restaurant'],
    policies: STANDARD_POLICIES,
    accentColor: null,
    featured: false,
    rating: 4.2,
    reviewCount: 74,
    plan: 'starter',
    status: 'PAST_DUE',
    interval: 'MONTHLY',
    periodEndsInDays: -5,
    createdDaysAgo: 95,
    owner: { fullName: 'Effiong Bassey', email: 'owner@marinacreek.ng', phone: '+234 814 555 0700', role: 'OWNER' },
    staff: [],
    roomTypes: [
      {
        name: 'Classic Double',
        description: 'A simple, spotless double with a garden view.',
        basePriceNaira: 35_000,
        hourlyPriceNaira: 10_000,
        capacity: 2,
        bedType: 'Double',
        sizeSqm: 18,
        amenities: ['Air conditioning', 'Shower', 'Free Wi-Fi'],
        images: [{ url: PHOTOS.roomMinimal, alt: 'Classic Double room' }],
      },
      {
        name: 'Creekside Deluxe',
        description: 'A larger room with a balcony over the creek.',
        basePriceNaira: 55_000,
        capacity: 3,
        bedType: 'Queen + Single',
        sizeSqm: 26,
        amenities: ['Air conditioning', 'Balcony', 'River view', 'Free Wi-Fi'],
        images: [{ url: PHOTOS.roomLinen, alt: 'Creekside Deluxe room' }],
      },
    ],
    rooms: roomsFor(
      [
        { floor: 1, from: 1, count: 6, type: 'Classic Double' },
        { floor: 2, from: 7, count: 4, type: 'Creekside Deluxe' },
      ],
      MIX,
    ),
  },
  {
    slug: 'bodija-heights',
    name: 'Bodija Heights Hotel',
    tagline: 'Hilltop rooms in Bodija, close to UI and the Secretariat.',
    description:
      'Bodija Heights looks over the rooftops of Ibadan. Visiting lecturers, wedding guests and weekend ' +
      'travellers all find their way here for the amala at lunch and the quiet evenings.',
    city: 'Ibadan',
    state: 'Oyo',
    area: 'Bodija',
    address: '11 Awolowo Avenue, Bodija, Ibadan',
    phone: '+234 815 555 0801',
    email: 'reservations@bodijaheights.ng',
    checkInTime: '14:00',
    checkOutTime: '12:00',
    coverImageUrl: PHOTOS.resortPool,
    images: [
      { url: PHOTOS.resortPool, alt: 'Pool and gardens' },
      { url: PHOTOS.roomModern, alt: 'Executive room' },
    ],
    amenities: ['Free Wi-Fi', '24-hour power', 'Swimming pool', 'Restaurant', 'Event hall', 'Secure parking'],
    policies: STANDARD_POLICIES,
    accentColor: null,
    featured: false,
    rating: 4.1,
    reviewCount: 58,
    plan: 'starter',
    status: 'ACTIVE',
    interval: 'MONTHLY',
    periodEndsInDays: 17,
    createdDaysAgo: 70,
    owner: { fullName: 'Oluwaseun Afolabi', email: 'owner@bodijaheights.ng', phone: '+234 815 555 0800', role: 'OWNER' },
    staff: [],
    roomTypes: [
      {
        name: 'Standard Room',
        description: 'A comfortable double with a city view.',
        basePriceNaira: 38_000,
        hourlyPriceNaira: 10_000,
        capacity: 2,
        bedType: 'Double',
        sizeSqm: 20,
        amenities: ['Air conditioning', 'Smart TV', 'Free Wi-Fi'],
        images: [{ url: PHOTOS.roomCosy, alt: 'Standard Room' }],
      },
      {
        name: 'Executive Room',
        description: 'A king bed, a sofa and a view across the city.',
        basePriceNaira: 58_000,
        capacity: 2,
        bedType: 'King',
        sizeSqm: 28,
        amenities: ['Air conditioning', 'Sofa', 'Minibar', 'Free Wi-Fi'],
        images: [{ url: PHOTOS.roomModern, alt: 'Executive Room' }],
      },
      {
        name: 'Heights Suite',
        description: 'Suite with lounge and dining area, popular with wedding parties.',
        basePriceNaira: 95_000,
        capacity: 3,
        bedType: 'King',
        sizeSqm: 45,
        amenities: ['Air conditioning', 'Lounge', 'Dining area', 'Bathtub', 'Free Wi-Fi'],
        images: [{ url: PHOTOS.roomSuite, alt: 'Heights Suite' }],
      },
    ],
    rooms: roomsFor(
      [
        { floor: 1, from: 101, count: 7, type: 'Standard Room' },
        { floor: 2, from: 201, count: 5, type: 'Executive Room' },
        { floor: 3, from: 301, count: 2, type: 'Heights Suite' },
      ],
      MIX,
    ),
  },
  {
    slug: 'coal-city-retreat',
    name: 'Coal City Retreat',
    tagline: 'Hillside comfort in Independence Layout with views of the Udi escarpment.',
    description:
      'A modern retreat in Enugu\'s quietest neighbourhood. Rooms are cool and airy, the pool is heated, ' +
      'and the restaurant serves ofe nsala and abacha alongside continental plates.',
    city: 'Enugu',
    state: 'Enugu',
    area: 'Independence Layout',
    address: '25 Nike Lake Road, Independence Layout, Enugu',
    phone: '+234 816 555 0901',
    email: 'stay@coalcityretreat.ng',
    checkInTime: '14:00',
    checkOutTime: '12:00',
    coverImageUrl: PHOTOS.villaPool,
    images: [
      { url: PHOTOS.villaPool, alt: 'Heated pool' },
      { url: PHOTOS.lobbyLounge, alt: 'Lounge' },
      { url: PHOTOS.roomSoft, alt: 'Deluxe room' },
    ],
    amenities: ['Free Wi-Fi', '24-hour power', 'Heated pool', 'Gym', 'Restaurant', 'Bar', 'Secure parking'],
    policies: STANDARD_POLICIES,
    accentColor: '#B98A2E',
    featured: true,
    rating: 4.6,
    reviewCount: 142,
    plan: 'growth',
    status: 'ACTIVE',
    interval: 'YEARLY',
    periodEndsInDays: 160,
    createdDaysAgo: 200,
    owner: { fullName: 'Chiamaka Nnaji', email: 'owner@coalcityretreat.ng', phone: '+234 816 555 0900', role: 'OWNER' },
    staff: [{ fullName: 'Obinna Ugwu', email: 'obinna@coalcityretreat.ng', phone: '+234 816 555 0902', role: 'MANAGER' }],
    roomTypes: [
      {
        name: 'Standard Queen',
        description: 'A bright queen room with a garden view.',
        basePriceNaira: 48_000,
        hourlyPriceNaira: 14_000,
        capacity: 2,
        bedType: 'Queen',
        sizeSqm: 22,
        amenities: ['Air conditioning', 'Smart TV', 'Free Wi-Fi'],
        images: [{ url: PHOTOS.roomQueen, alt: 'Standard Queen room' }],
      },
      {
        name: 'Deluxe King',
        description: 'A king room with an escarpment view and a reading nook.',
        basePriceNaira: 72_000,
        capacity: 2,
        bedType: 'King',
        sizeSqm: 30,
        amenities: ['Air conditioning', 'Hill view', 'Minibar', 'Free Wi-Fi'],
        images: [{ url: PHOTOS.roomSoft, alt: 'Deluxe King room' }],
      },
      {
        name: 'Junior Suite',
        description: 'Open-plan suite with a sitting area and a soaking tub.',
        basePriceNaira: 110_000,
        capacity: 3,
        bedType: 'King',
        sizeSqm: 40,
        amenities: ['Air conditioning', 'Sitting area', 'Soaking tub', 'Free Wi-Fi'],
        images: [{ url: PHOTOS.roomWhite, alt: 'Junior Suite' }],
      },
    ],
    rooms: roomsFor(
      [
        { floor: 1, from: 101, count: 6, type: 'Standard Queen' },
        { floor: 2, from: 201, count: 5, type: 'Deluxe King' },
        { floor: 3, from: 301, count: 3, type: 'Junior Suite' },
      ],
      MIX,
    ),
  },
];

export const ALL_HOTELS: HotelSeed[] = [DEMO_HOTEL, ...MARKETPLACE_HOTELS];

/** Every image URL referenced by the seed, for `pnpm images:verify`. */
export function allImageUrls(): string[] {
  return [...new Set(Object.values(PHOTOS))];
}
