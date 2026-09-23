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
    rating: p.rating,
    reviewCount: p.reviewCount,
    amenities: p.amenities,
    featured: p.featured,
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
