import type { Property, RoomType } from '../../generated/prisma/client.js';

export interface ImageRef {
  url: string;
  alt: string;
}

export interface HotelCard {
  slug: string;
  name: string;
  tagline: string;
  city: string;
  state: string;
  area: string;
  coverImageUrl: string | null;
  startingRateKobo: number | null;
  rating: number | null;
  reviewCount: number;
  amenities: string[];
  featured: boolean;
  onlinePayment: boolean;
  payAtHotel: boolean;
  onlineBookingEnabled: boolean;
  freeCancellationHours: number;
  searchAvailability: {
    checkIn: string;
    checkOut: string;
    nights: number;
    availableRoomTypes: number;
    cheapestRateKobo: number;
    cheapestTotalKobo: number;
  } | null;
  /** M5: the hotel group when it has 2+ properties ("Part of ... group"). */
  group?: { slug: string; name: string; propertyCount: number } | null;
}

export interface ReviewSummary {
  rating: number | null;
  count: number;
  subscores: { cleanliness: number | null; service: number | null; location: number | null; value: number | null };
  distribution: { '1': number; '2': number; '3': number; '4': number; '5': number };
  byTravellerType: Record<'BUSINESS' | 'COUPLE' | 'FAMILY' | 'SOLO' | 'FRIENDS', number>;
}

/** Review aggregates kept on the property row (see ReviewsService.recompute). */
export function reviewSummaryOf(p: Property): ReviewSummary {
  const d = (p.ratingDistribution ?? {}) as { stars?: Record<string, number>; byTravellerType?: Record<string, number> };
  const stars = d.stars ?? {};
  const tt = d.byTravellerType ?? {};
  return {
    rating: p.reviewCount > 0 ? p.rating : null,
    count: p.reviewCount,
    subscores: {
      cleanliness: p.ratingCleanliness,
      service: p.ratingService,
      location: p.ratingLocation,
      value: p.ratingValue,
    },
    distribution: { '1': stars['1'] ?? 0, '2': stars['2'] ?? 0, '3': stars['3'] ?? 0, '4': stars['4'] ?? 0, '5': stars['5'] ?? 0 },
    byTravellerType: {
      BUSINESS: tt.BUSINESS ?? 0,
      COUPLE: tt.COUPLE ?? 0,
      FAMILY: tt.FAMILY ?? 0,
      SOLO: tt.SOLO ?? 0,
      FRIENDS: tt.FRIENDS ?? 0,
    },
  };
}

export interface RoomTypePublic {
  id: string;
  name: string;
  description: string;
  basePriceKobo: number;
  hourlyPriceKobo: number | null;
  capacity: number;
  bedType: string;
  sizeSqm: number;
  amenities: string[];
  images: ImageRef[];
  availableCount: number;
}

export interface HotelDetail extends HotelCard {
  description: string;
  address: string;
  phone: string;
  email: string;
  checkInTime: string;
  checkOutTime: string;
  images: ImageRef[];
  roomTypes: RoomTypePublic[];
  policies: string[];
  branding: { accentColor: string | null; logoUrl: string | null };
  mapUrl: string;
  booking: {
    onlineBookingEnabled: boolean;
    payOnlineAvailable: boolean;
    payAtHotelAvailable: boolean;
    holdMinutes: number;
    marketplaceListed: boolean;
    dayUseAvailable: boolean;
    cancellationPolicy: { freeCancellationHours: number; lateCancellationFeePct: number; noShowFeePct: number; summary: string };
    taxes: { code: 'VAT' | 'CONSUMPTION' | 'SERVICE_CHARGE'; label: string; rateBps: number; inclusive: boolean }[];
  };
  reviewSummary: ReviewSummary;
  /** M5 */
  canonicalUrl: string;
  whatsapp: { available: boolean; phone: string | null; waUrl: string | null };
}

/** Coerces the JSON `images` column into `{ url, alt }[]`. */
export function toImages(raw: unknown): ImageRef[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter(
      (i): i is { url: string; alt?: string } =>
        typeof i === 'object' &&
        i !== null &&
        typeof (i as { url?: unknown }).url === 'string',
    )
    .map((i) => ({ url: i.url, alt: typeof i.alt === 'string' ? i.alt : '' }));
}

export function toHotelCard(
  p: Property,
  roomTypePrices: readonly number[],
  searchAvailability: HotelCard['searchAvailability'] = null,
): HotelCard {
  return {
    slug: p.slug,
    name: p.name,
    tagline: p.tagline,
    city: p.city,
    state: p.state,
    area: p.area,
    coverImageUrl: p.coverImageUrl,
    startingRateKobo: roomTypePrices.length ? Math.min(...roomTypePrices) : null,
    rating: p.reviewCount > 0 ? p.rating : null,
    reviewCount: p.reviewCount,
    amenities: p.amenities,
    featured: p.featured,
    onlinePayment: p.payoutReady,
    payAtHotel: p.allowPayAtHotel,
    onlineBookingEnabled: p.onlineBookingEnabled,
    freeCancellationHours: p.freeCancellationHours,
    searchAvailability,
  };
}

export function toRoomTypePublic(
  rt: RoomType,
  availableCount: number,
): RoomTypePublic {
  return {
    id: rt.id,
    name: rt.name,
    description: rt.description,
    basePriceKobo: rt.basePriceKobo,
    hourlyPriceKobo: rt.hourlyPriceKobo,
    capacity: rt.capacity,
    bedType: rt.bedType,
    sizeSqm: rt.sizeSqm,
    amenities: rt.amenities,
    images: toImages(rt.images),
    availableCount,
  };
}
