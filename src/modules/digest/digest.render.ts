import type { GuardRule, GuardSeverity, PaymentMethod } from '../../generated/prisma/enums.js';
import { PAYMENT_METHODS } from '../reports/stats.compute.js';

export interface DigestData {
  businessDate: string;
  hotelName: string;
  roomsSold: number;
  roomsAvailable: number;
  occupancyRate: number;
  dayUseCount: number;
  arrivals: number;
  departures: number;
  roomRevenueKobo: number;
  totalRevenueKobo: number;
  revenueByMethod: Record<PaymentMethod, number>;
  paymentsTotalKobo: number;
  openFlags: number;
  topFlags: { rule: GuardRule; severity: GuardSeverity; title: string }[];
}

const naira = (kobo: number) => `₦${Math.round(kobo / 100).toLocaleString('en-NG')}`;
const METHOD_LABEL: Record<PaymentMethod, string> = {
  CASH: 'Cash',
  TRANSFER: 'Transfer',
  POS: 'POS',
  CARD_ONLINE: 'Card online',
  COMPLIMENTARY: 'Complimentary',
  CITY_LEDGER: 'City ledger',
};

/** Plain-text WhatsApp message (uses *bold*). */
export function renderDigest(d: DigestData, appName: string): string {
  const lines = [
    `*${d.hotelName}* daily summary, ${d.businessDate}`,
    '',
    `Rooms sold: *${d.roomsSold}* of ${d.roomsAvailable} (${Math.round(d.occupancyRate * 100)}% occupancy)`,
    `Day-use stays: ${d.dayUseCount}`,
    `Check-ins: ${d.arrivals}   Check-outs: ${d.departures}`,
    '',
    `Revenue: *${naira(d.totalRevenueKobo)}* (rooms ${naira(d.roomRevenueKobo)})`,
    `Money received: *${naira(d.paymentsTotalKobo)}*`,
    ...PAYMENT_METHODS.filter((m) => d.revenueByMethod[m]).map((m) => `  ${METHOD_LABEL[m]}: ${naira(d.revenueByMethod[m])}`),
    '',
    d.openFlags ? `Revenue Guard: *${d.openFlags} open flag${d.openFlags === 1 ? '' : 's'}*` : 'Revenue Guard: no open flags',
    ...d.topFlags.map((f, i) => `  ${i + 1}. [${f.severity}] ${f.title}`),
    '',
    `Sent by ${appName}`,
  ];
  return lines.join('\n');
}
