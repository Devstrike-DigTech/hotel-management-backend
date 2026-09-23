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
