import type { Property } from '../../generated/prisma/client.js';
import { AppException } from '../../common/errors/app-exception.js';
import type { Tx } from '../../prisma/db.service.js';

/**
 * The tenant's primary (first-created) property. Multi-property tenants
 * manage additional properties in a later milestone; every M1 hotel route
 * operates on the primary one.
 */
export async function primaryProperty(
  tx: Tx,
  tenantId: string,
): Promise<Property> {
  const p = await tx.property.findFirst({
    where: { tenantId },
    orderBy: { createdAt: 'asc' },
  });
  if (!p) throw AppException.notFound('Property');
  return p;
}
