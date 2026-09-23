import type { Tx } from '../../prisma/db.service.js';
import { lagosDate } from '../../common/time/lagos.js';

/**
 * Marks the property's active Channex connections as needing an ARI push
 * for [from, to] (Lagos dates, inclusive). Called inside the transaction of
 * the change (a reservation, a room block, a rate change), so the mark
 * commits with it. A job pushes marked connections once they have been
 * quiet for the debounce window, and only values that changed are sent.
 * Without connections this is a no-op update.
 */
export async function markAriDirty(tx: Tx, tenantId: string, propertyId: string, from?: Date | string | null, to?: Date | string | null): Promise<void> {
  const f = from ? (typeof from === 'string' ? from : lagosDate(from)) : lagosDate();
  const t = to ? (typeof to === 'string' ? to : lagosDate(to)) : f;
  await tx.$executeRaw`
    UPDATE channel_connections
       SET ari_dirty_since = COALESCE(ari_dirty_since, now()),
           ari_dirty_from = LEAST(COALESCE(ari_dirty_from, ${f}::date), ${f}::date),
           ari_dirty_to = GREATEST(COALESCE(ari_dirty_to, ${t}::date), ${t}::date)
     WHERE tenant_id = ${tenantId}::uuid AND property_id = ${propertyId}::uuid
       AND provider = 'CHANNEX' AND status IN ('ACTIVE', 'ERROR')`;
}
