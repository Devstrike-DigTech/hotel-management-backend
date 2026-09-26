import { Logger } from '@nestjs/common';
import type { Tx } from '../prisma/db.service.js';

/**
 * Stay lifecycle hooks (M5). Pro modules (guest inbox, loyalty) react to
 * check-in and check-out without the reservations module importing them.
 *
 * - `*Tx` hooks run inside the check-in / check-out transaction, each under a
 *   savepoint: a failing hook is logged and never fails the stay action.
 * - `after*` hooks run after the commit (messages to the guest); errors are
 *   logged.
 * - `detailTx` adds fields to ReservationDetail.
 */
export interface StayHooks {
  name: string;
  checkedInTx?(tx: Tx, tenantId: string, reservationId: string, opts: Record<string, unknown>): Promise<void>;
  afterCheckIn?(tenantId: string, reservationId: string): Promise<void>;
  checkedOutTx?(tx: Tx, tenantId: string, reservationId: string, opts: Record<string, unknown>): Promise<void>;
  /** A stay that will not happen (cancelled, hold expired): `opts.why` says why. */
  releasedTx?(tx: Tx, tenantId: string, reservationId: string, opts: Record<string, unknown>): Promise<void>;
  /** Folio entries just voided (inside the void's transaction). */
  entriesVoidedTx?(tx: Tx, tenantId: string, entryIds: string[]): Promise<void>;
  afterCheckOut?(tenantId: string, reservationId: string): Promise<void>;
  /** After the 24-hour pre-arrival message went out. */
  afterPreArrival?(tenantId: string, reservationId: string): Promise<void>;
  detailTx?(tx: Tx, tenantId: string, reservationId: string): Promise<Record<string, unknown>>;
  /** M7: fields added to the guest-facing BookingView (trip page, confirmation). */
  guestViewTx?(tx: Tx, tenantId: string, reservationId: string): Promise<Record<string, unknown>>;
  /** M7: fields added to partner API reservations and webhook payloads, per reservation id. */
  partnerTx?(tx: Tx, tenantId: string, reservationIds: string[], opts: { includeSensitive: boolean }): Promise<Map<string, Record<string, unknown>>>;
  /** M7: fields added to each reservation of an NDPA guest export (everything held, sensitive included). */
  guestExportTx?(tx: Tx, tenantId: string, reservationIds: string[]): Promise<Map<string, Record<string, unknown>>>;
  /** M7: NDPA erasure of the guest's reservations; the returned function runs after the commit (file deletes). */
  guestErasedTx?(tx: Tx, tenantId: string, reservationIds: string[]): Promise<(() => Promise<void>) | void>;
  /** M8: fields added to the top level of an NDPA guest export (data held per guest, not per stay). */
  guestRecordExportTx?(tx: Tx, tenantId: string, guestId: string): Promise<Record<string, unknown>>;
  /** M8: NDPA erasure of data held per guest (inside the anonymise transaction). */
  guestRecordErasedTx?(tx: Tx, tenantId: string, guestId: string): Promise<void>;
}

const registry = new Map<string, StayHooks>();
const logger = new Logger('StayHooks');

export function registerStayHooks(h: StayHooks): void {
  registry.set(h.name, h);
}

export async function runStayHooksTx(kind: 'checkedInTx' | 'checkedOutTx' | 'releasedTx', tx: Tx, tenantId: string, reservationId: string, opts: Record<string, unknown> = {}): Promise<void> {
  for (const h of registry.values()) {
    const fn = h[kind];
    if (!fn) continue;
    const sp = `stay_hook_${h.name.replace(/\W/g, '_')}`;
    await tx.$executeRawUnsafe(`SAVEPOINT ${sp}`);
    try {
      await fn.call(h, tx, tenantId, reservationId, opts);
      await tx.$executeRawUnsafe(`RELEASE SAVEPOINT ${sp}`);
    } catch (e) {
      await tx.$executeRawUnsafe(`ROLLBACK TO SAVEPOINT ${sp}`);
      logger.error(`${h.name}.${kind} failed for reservation ${reservationId}: ${(e as Error).message}`);
    }
  }
}

/** Voided folio entries (not under a savepoint: a failure fails the void, keeping points and ledger in step). */
export async function runVoidHooksTx(tx: Tx, tenantId: string, entryIds: string[]): Promise<void> {
  for (const h of registry.values()) if (h.entriesVoidedTx) await h.entriesVoidedTx(tx, tenantId, entryIds);
}

export async function runStayHooksAfter(kind: 'afterCheckIn' | 'afterCheckOut' | 'afterPreArrival', tenantId: string, reservationId: string): Promise<void> {
  for (const h of registry.values()) {
    const fn = h[kind];
    if (!fn) continue;
    try {
      await fn.call(h, tenantId, reservationId);
    } catch (e) {
      logger.error(`${h.name}.${kind} failed for reservation ${reservationId}: ${(e as Error).message}`);
    }
  }
}

export async function stayDetailExtras(tx: Tx, tenantId: string, reservationId: string): Promise<Record<string, unknown>> {
  const out: Record<string, unknown> = {};
  for (const h of registry.values()) {
    if (h.detailTx) Object.assign(out, await h.detailTx(tx, tenantId, reservationId));
  }
  return out;
}

export async function stayGuestExtras(tx: Tx, tenantId: string, reservationId: string): Promise<Record<string, unknown>> {
  const out: Record<string, unknown> = {};
  for (const h of registry.values()) {
    if (h.guestViewTx) Object.assign(out, await h.guestViewTx(tx, tenantId, reservationId));
  }
  return out;
}

export async function stayPartnerExtras(tx: Tx, tenantId: string, reservationIds: string[], opts: { includeSensitive: boolean }): Promise<Map<string, Record<string, unknown>>> {
  const out = new Map<string, Record<string, unknown>>(reservationIds.map((id) => [id, {}]));
  for (const h of registry.values()) {
    if (!h.partnerTx || !reservationIds.length) continue;
    const m = await h.partnerTx(tx, tenantId, reservationIds, opts);
    for (const [id, v] of m) Object.assign(out.get(id) ?? {}, v);
  }
  return out;
}

export async function stayGuestExport(tx: Tx, tenantId: string, reservationIds: string[]): Promise<Map<string, Record<string, unknown>>> {
  const out = new Map<string, Record<string, unknown>>(reservationIds.map((id) => [id, {}]));
  for (const h of registry.values()) {
    if (!h.guestExportTx || !reservationIds.length) continue;
    const m = await h.guestExportTx(tx, tenantId, reservationIds);
    for (const [id, v] of m) Object.assign(out.get(id) ?? {}, v);
  }
  return out;
}

/** Runs every erasure hook in the transaction; returns the after-commit work. */
export async function stayGuestErased(tx: Tx, tenantId: string, reservationIds: string[]): Promise<() => Promise<void>> {
  const after: (() => Promise<void>)[] = [];
  for (const h of registry.values()) {
    if (!h.guestErasedTx || !reservationIds.length) continue;
    const fn = await h.guestErasedTx(tx, tenantId, reservationIds);
    if (fn) after.push(fn);
  }
  return async () => {
    for (const fn of after) await fn().catch((e: unknown) => logger.error(`guest erasure cleanup failed: ${(e as Error).message}`));
  };
}

/** M8: guest-level data for an NDPA export (e.g. concierge requests). */
export async function guestRecordExport(tx: Tx, tenantId: string, guestId: string): Promise<Record<string, unknown>> {
  const out: Record<string, unknown> = {};
  for (const h of registry.values()) {
    if (h.guestRecordExportTx) Object.assign(out, await h.guestRecordExportTx(tx, tenantId, guestId));
  }
  return out;
}

/** M8: guest-level NDPA erasure hooks. */
export async function guestRecordErased(tx: Tx, tenantId: string, guestId: string): Promise<void> {
  for (const h of registry.values()) if (h.guestRecordErasedTx) await h.guestRecordErasedTx(tx, tenantId, guestId);
}
