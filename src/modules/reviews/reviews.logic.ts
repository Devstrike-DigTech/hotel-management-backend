export const TRAVELLER_TYPES = ['BUSINESS', 'COUPLE', 'FAMILY', 'SOLO', 'FRIENDS'] as const;
export type TravellerType = (typeof TRAVELLER_TYPES)[number];

/** "Chiamaka Okonkwo-Eze" -> "Chiamaka O."; single names stay as they are. */
export function displayName(fullName: string): string {
  const parts = fullName.trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return 'Guest';
  const first = capitalise(parts[0]);
  if (parts.length === 1) return first;
  const last = parts[parts.length - 1].replace(/[^A-Za-z]/g, '');
  return last ? `${first} ${last[0].toUpperCase()}.` : first;
}

function capitalise(w: string): string {
  return w.charAt(0).toUpperCase() + w.slice(1).toLowerCase();
}

/** Text that looks like it carries contact details (phone number or email). */
export function looksLikePii(text: string): boolean {
  if (/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i.test(text)) return true;
  const digits = text.replace(/[\s\-().]/g, '');
  return /(\+?234|0)[789][01]\d{8}/.test(digits);
}

export interface ScoreRow {
  overall: number;
  cleanliness: number;
  service: number;
  location: number;
  value: number;
  travellerType: string;
}

export interface Aggregate {
  rating: number | null;
  count: number;
  cleanliness: number | null;
  service: number | null;
  location: number | null;
  value: number | null;
  stars: Record<'1' | '2' | '3' | '4' | '5', number>;
  byTravellerType: Record<TravellerType, number>;
}

const avg = (xs: number[]) => (xs.length ? Math.round((xs.reduce((a, b) => a + b, 0) / xs.length) * 10) / 10 : null);

/** Averages to one decimal, star distribution and traveller-type counts. */
export function aggregate(rows: ScoreRow[]): Aggregate {
  const stars = { '1': 0, '2': 0, '3': 0, '4': 0, '5': 0 };
  const byTravellerType = { BUSINESS: 0, COUPLE: 0, FAMILY: 0, SOLO: 0, FRIENDS: 0 };
  for (const r of rows) {
    const k = String(Math.min(5, Math.max(1, Math.round(r.overall)))) as keyof typeof stars;
    stars[k]++;
    if (r.travellerType in byTravellerType) byTravellerType[r.travellerType as TravellerType]++;
  }
  return {
    rating: avg(rows.map((r) => r.overall)),
    count: rows.length,
    cleanliness: avg(rows.map((r) => r.cleanliness)),
    service: avg(rows.map((r) => r.service)),
    location: avg(rows.map((r) => r.location)),
    value: avg(rows.map((r) => r.value)),
    stars,
    byTravellerType,
  };
}

/** "2026-08" from a Lagos date. */
export function stayMonth(lagosDate: string): string {
  return lagosDate.slice(0, 7);
}
