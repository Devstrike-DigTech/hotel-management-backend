/** Partner API resource shapes (API-M6 12.5). Stable: change only additively. */
import type { HousekeepingTask, Property, Room, RoomType } from '../../../generated/prisma/client.js';
import type { NightlyRate } from '../../rates/rates.logic.js';

export function pProperty(p: Property) {
  return {
    id: p.id,
    name: p.name,
    slug: p.slug,
    city: p.city,
    state: p.state,
    area: p.area,
    address: p.address,
    phone: p.phone,
    email: p.email,
    timezone: 'Africa/Lagos' as const,
    checkInTime: p.checkInTime,
    checkOutTime: p.checkOutTime,
    currency: 'NGN' as const,
  };
}

export function pRoomType(t: RoomType, roomCount: number) {
  return {
    id: t.id,
    propertyId: t.propertyId,
    name: t.name,
    description: t.description,
    capacity: t.capacity,
    bedType: t.bedType,
    sizeSqm: t.sizeSqm,
    basePriceKobo: t.basePriceKobo,
    amenities: t.amenities,
    roomCount,
  };
}

export function pRoom(r: Pick<Room, 'id' | 'propertyId' | 'roomTypeId' | 'number' | 'floor' | 'status' | 'updatedAt'>) {
  return {
    id: r.id,
    propertyId: r.propertyId,
    roomTypeId: r.roomTypeId,
    number: r.number,
    floor: r.floor,
    status: r.status,
    updatedAt: r.updatedAt.toISOString(),
  };
}

/** Internal rate sources folded into the four the partner API documents. */
export function pRateSource(s: NightlyRate['source']): 'BASE' | 'SEASON' | 'OVERRIDE' | 'PRICING' {
  switch (s) {
    case 'RULE':
      return 'SEASON';
    case 'OVERRIDE':
    case 'MANUAL':
      return 'OVERRIDE';
    case 'FIXED':
    case 'BASE':
    default:
      return 'BASE';
  }
}

/** Shape shared by the reservation list item and detail views. */
export interface ReservationLike {
  id: string;
  code: string;
  propertyId: string;
  status: string;
  source: string;
  stayType: string;
  arrivalDate: string;
  departureDate: string;
  arrivalAt: string;
  departureAt: string;
  nights: number | null;
  adults: number;
  children: number;
  roomType: { id: string; name: string };
  room: { id: string; number: string } | null;
  ratePlan: { id: string; name: string } | null;
  rateKobo: number;
  nightlyRates?: { date: string; rateKobo: number }[];
  guest: { id: string; fullName: string };
  notes?: string;
  externalRef?: string | null;
  createdAt: string;
  updatedAt: string;
  cancelledAt?: string | null;
}

export function pReservation(r: ReservationLike, nightly?: { date: string; rateKobo: number }[]) {
  return {
    id: r.id,
    code: r.code,
    propertyId: r.propertyId,
    status: r.status,
    source: r.source,
    stayType: r.stayType as 'NIGHTLY' | 'DAY_USE',
    arrivalDate: r.arrivalDate,
    departureDate: r.departureDate,
    arrivalAt: r.arrivalAt,
    departureAt: r.departureAt,
    nights: r.nights ?? 0,
    adults: r.adults,
    children: r.children,
    roomType: { id: r.roomType.id, name: r.roomType.name },
    room: r.room ? { id: r.room.id, number: r.room.number } : null,
    ratePlan: r.ratePlan ? { id: r.ratePlan.id, name: r.ratePlan.name } : null,
    rateKobo: r.rateKobo,
    nightlyRates: (nightly ?? r.nightlyRates ?? []).map((n) => ({ date: n.date, rateKobo: n.rateKobo })),
    guest: { id: r.guest.id, fullName: r.guest.fullName },
    notes: r.notes ? r.notes : null,
    externalRef: r.externalRef ?? null,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
    cancelledAt: r.cancelledAt ?? null,
  };
}

export function pGuest(g: { id: string; fullName: string; phone: string | null; email: string | null; nationality: string | null; vip: boolean; createdAt: Date }) {
  return {
    id: g.id,
    fullName: g.fullName,
    phone: g.phone,
    email: g.email,
    nationality: g.nationality,
    vip: g.vip,
    createdAt: g.createdAt.toISOString(),
  };
}

export function pTask(t: HousekeepingTask & { room: { number: string } }) {
  return {
    id: t.id,
    propertyId: t.propertyId,
    roomId: t.roomId,
    roomNumber: t.room.number,
    type: t.type,
    status: t.status,
    priority: t.priority,
    assignee: t.assigneeId ? { id: t.assigneeId, fullName: t.assigneeName ?? '' } : null,
    dueAt: t.dueAt?.toISOString() ?? null,
    completedAt: t.completedAt?.toISOString() ?? null,
    createdAt: t.createdAt.toISOString(),
  };
}

export function pDailyStats(f: {
  propertyId?: string | null;
  date: string;
  roomsAvailable: number;
  roomsSold: number;
  occupancyRate: number;
  adrKobo: number;
  revparKobo: number;
  roomRevenueKobo: number;
  totalRevenueKobo: number;
  arrivals: number;
  departures: number;
  noShows: number;
}, propertyId: string) {
  return {
    propertyId: f.propertyId ?? propertyId,
    date: f.date,
    roomsAvailable: f.roomsAvailable,
    roomsSold: f.roomsSold,
    occupancyPct: Math.round(f.occupancyRate * 1000) / 10,
    adrKobo: f.adrKobo,
    revparKobo: f.revparKobo,
    roomRevenueKobo: f.roomRevenueKobo,
    totalRevenueKobo: f.totalRevenueKobo,
    arrivals: f.arrivals,
    departures: f.departures,
    noShows: f.noShows,
  };
}
