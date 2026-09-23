import type { CityLedgerInvoice } from '../../generated/prisma/client.js';
import { diffDays, fromDbDate, lagosDate } from '../../common/time/lagos.js';
import type { Tx } from '../../prisma/db.service.js';
import { k, primaryProperty } from '../ops/ops.helpers.js';
import { agingBucket } from './city-ledger.logic.js';

export function invoiceListView(inv: CityLedgerInvoice & { account: { id: string; name: string } }, today = lagosDate()) {
  const total = k(inv.totalKobo);
  const paid = k(inv.paidKobo);
  const issue = fromDbDate(inv.issueDate);
  const due = fromDbDate(inv.dueDate);
  const days = Math.max(0, diffDays(issue, today));
  const open = inv.status === 'OPEN' || inv.status === 'PARTIALLY_PAID';
  return {
    id: inv.id,
    number: inv.number,
    kind: inv.kind,
    account: { id: inv.account.id, name: inv.account.name },
    periodFrom: inv.periodFrom ? fromDbDate(inv.periodFrom) : null,
    periodTo: inv.periodTo ? fromDbDate(inv.periodTo) : null,
    issueDate: issue,
    dueDate: due,
    totalKobo: total,
    paidKobo: paid,
    balanceKobo: inv.status === 'VOID' ? 0 : Math.max(0, total - paid),
    status: inv.status,
    daysOutstanding: open ? days : 0,
    bucket: agingBucket(days),
    overdue: open && today > due,
    remindersSent: inv.remindersSent,
    lastReminderAt: inv.lastReminderAt?.toISOString() ?? null,
    createdAt: inv.createdAt.toISOString(),
  };
}

/** Printable City Ledger statement (live: payments and status are current). */
export async function buildCityLedgerDocument(tx: Tx, tenantId: string, invoiceId: string, appName: string) {
  const inv = await tx.cityLedgerInvoice.findFirst({
    where: { id: invoiceId, tenantId },
    include: {
      account: true,
      charges: { orderBy: { date: 'asc' } },
      allocations: { include: { payment: true }, orderBy: { createdAt: 'asc' } },
    },
  });
  if (!inv) return null;
  const p = await primaryProperty(tx, tenantId);
  return {
    ...invoiceListView(inv),
    hotel: {
      name: p.name,
      address: p.address,
      area: p.area,
      city: p.city,
      state: p.state,
      phone: p.phone,
      email: p.email,
      logoUrl: p.logoUrl,
      accentColor: p.accentColor,
      appName,
    },
    billTo: {
      name: inv.account.name,
      contactName: inv.account.contactName,
      email: inv.account.email,
      phone: inv.account.phone,
      address: inv.account.address,
      taxId: inv.account.taxId,
    },
    lines: inv.charges.map((c) => ({
      date: fromDbDate(c.date),
      reservationCode: c.reservationCode,
      guestName: c.guestName,
      description: c.description,
      amountKobo: k(c.amountKobo),
    })),
    payments: inv.allocations.map((a) => ({
      date: lagosDate(a.payment.receivedAt),
      method: a.payment.method,
      reference: a.payment.reference,
      amountKobo: k(a.amountKobo),
    })),
    notes: inv.notes,
    voidReason: inv.voidReason,
    issuedBy: inv.issuedById ? { id: inv.issuedById, fullName: inv.issuedByName ?? '' } : null,
    currency: 'NGN' as const,
  };
}
