import type { Property } from '../../generated/prisma/client.js';
import type { Tx } from '../../prisma/db.service.js';
import { primaryProperty as currentProperty } from '../ops/ops.helpers.js';

/**
 * The property of the current request (M5 property scope; see
 * common/property-scope.ts), or the tenant's primary property outside one.
 */
export async function primaryProperty(tx: Tx, tenantId: string): Promise<Property> {
  return currentProperty(tx, tenantId);
}
