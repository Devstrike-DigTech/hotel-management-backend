import type { FolioEntry, Guest, Reservation, Room, RoomType } from '../../generated/prisma/client.js';
import type { GuestInvoiceKind, PaymentMethod, TaxCode } from '../../generated/prisma/enums.js';
import { billableHours, fromDbDate, lagosDate, nightsBetween } from '../../common/time/lagos.js';
import { amountInWords } from '../../common/utils/money-words.js';
import { folioTotals, sortEntries, voidIndex } from '../folios/folio.logic.js';
import { k } from '../ops/ops.helpers.js';

export interface HotelHeader {
  name: string;
  address: string;
  area: string;
  city: string;
  state: string;
  phone: string;
  email: string;
  logoUrl: string | null;
  accentColor: string | null;
  appName: string;
}

export type Issuer = { id: string; fullName: string } | null;

export interface FolioLike {
  id: string;
  name: string;
  entries: FolioEntry[];
  guest: Guest | null;
  reservation: (Pick<Reservation, 'code' | 'stayType' | 'arrivalAt' | 'departureAt' | 'adults' | 'children'> & { room: Room | null; roomType: RoomType }) | null;
}

/** The printable invoice, snapshotted into guest_invoices.document at issue time. */
export function buildInvoiceDocument(input: {
  folio: FolioLike;
  receiptNumbers: Map<string, string>;
  hotel: HotelHeader;
  number: string;
  kind: GuestInvoiceKind;
  issuedAt: Date;
  issuer: Issuer;
}) {
  const { folio, hotel } = input;
  const entries = sortEntries(folio.entries);
  const voids = voidIndex(entries);
  const live = entries.filter((e) => e.type !== 'VOID' && !voids.has(e.id));
  const lines = live
    .filter((e) => ['ROOM', 'DAY_USE', 'EXTRA', 'DISCOUNT'].includes(e.type))
    .map((e) => ({
      date: fromDbDate(e.businessDate),
      type: e.type as 'ROOM' | 'DAY_USE' | 'EXTRA' | 'DISCOUNT',
      description: e.description,
      amountKobo: k(e.amountKobo),
    }));
  const taxMap = new Map<string, { code: TaxCode; label: string; rateBps: number; inclusive: boolean; amountKobo: number }>();
  for (const e of live.filter((x) => x.type === 'TAX' || x.type === 'SERVICE_CHARGE')) {
    const code: TaxCode = e.taxCode ?? (e.type === 'SERVICE_CHARGE' ? 'SERVICE_CHARGE' : 'VAT');
    const key = `${code}:${e.rateBps}:${e.inclusive}`;
    const cur = taxMap.get(key) ?? { code, label: e.description, rateBps: e.rateBps ?? 0, inclusive: !!e.inclusive, amountKobo: 0 };
    cur.amountKobo += k(e.amountKobo);
    taxMap.set(key, cur);
  }
  const totals = folioTotals(entries);
  const r = folio.reservation;
  return {
    id: '',
    number: input.number,
    kind: input.kind,
    issuedAt: input.issuedAt.toISOString(),
    businessDate: lagosDate(input.issuedAt),
    hotel,
    guest: folio.guest
      ? { fullName: folio.guest.fullName, phone: folio.guest.phone, email: folio.guest.email, company: folio.guest.company, address: folio.guest.address }
      : null,
    folio: { id: folio.id, name: folio.name },
    reservation: r
      ? {
          code: r.code,
          roomNumber: r.room?.number ?? null,
          roomTypeName: r.roomType.name,
          stayType: r.stayType,
          arrivalAt: r.arrivalAt.toISOString(),
          departureAt: r.departureAt.toISOString(),
          nights: r.stayType === 'NIGHTLY' ? nightsBetween(r.arrivalAt, r.departureAt) : null,
          hours: r.stayType === 'DAY_USE' ? billableHours(r.arrivalAt, r.departureAt) : null,
          adults: r.adults,
          children: r.children,
        }
      : null,
    lines,
    taxes: [...taxMap.values()].filter((t) => t.amountKobo !== 0),
    payments: live
      .filter((e) => e.type === 'PAYMENT')
      .map((e) => ({
        date: fromDbDate(e.businessDate),
        method: e.paymentMethod as PaymentMethod,
        reference: e.paymentRef,
        receiptNumber: input.receiptNumbers.get(e.id) ?? null,
        amountKobo: -k(e.amountKobo),
      })),
    refunds: live
      .filter((e) => e.type === 'REFUND')
      .map((e) => ({ date: fromDbDate(e.businessDate), method: e.paymentMethod as PaymentMethod, amountKobo: k(e.amountKobo) })),
    totals: {
      subtotalKobo: totals.chargesKobo,
      discountKobo: totals.discountsKobo,
      taxKobo: totals.taxKobo,
      serviceChargeKobo: totals.serviceChargeKobo,
      totalKobo: totals.chargesKobo - totals.discountsKobo + totals.taxKobo + totals.serviceChargeKobo,
      paidKobo: totals.paymentsKobo - totals.refundsKobo,
      balanceKobo: totals.balanceKobo,
    },
    issuedBy: input.issuer,
    currency: 'NGN' as const,
  };
}

/** The printable receipt for one payment entry. */
export function buildReceiptDocument(input: {
  folio: FolioLike;
  entry: FolioEntry;
  hotel: HotelHeader;
  number: string;
  issuedAt: Date;
  balanceAfterKobo: number;
  issuer: Issuer;
}) {
  const amount = -k(input.entry.amountKobo);
  return {
    id: '',
    number: input.number,
    issuedAt: input.issuedAt.toISOString(),
    hotel: input.hotel,
    guestName: input.folio.guest?.fullName ?? input.folio.name,
    folioId: input.folio.id,
    reservationCode: input.folio.reservation?.code ?? null,
    roomNumber: input.folio.reservation?.room?.number ?? null,
    method: input.entry.paymentMethod as PaymentMethod,
    reference: input.entry.paymentRef,
    amountKobo: amount,
    amountInWords: amountInWords(amount),
    folioBalanceAfterKobo: input.balanceAfterKobo,
    receivedBy: input.issuer,
    voided: false,
    currency: 'NGN' as const,
  };
}
