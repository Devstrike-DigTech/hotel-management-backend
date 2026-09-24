import type { Tx } from '../prisma/db.service.js';

/**
 * M6: domain events that are not audit entries (guard flags), raised inside
 * the business transaction. Outbound webhooks subscribe at start-up; a
 * module-level registry keeps the emitting services free of that dependency.
 */
export interface DomainEvent {
  tenantId: string;
  propertyId: string | null;
  type: string;
  object: Record<string, unknown>;
}

export type DomainEventHook = (tx: Tx, e: DomainEvent) => Promise<void>;

const hooks: DomainEventHook[] = [];

export function onDomainEvent(hook: DomainEventHook): void {
  if (!hooks.includes(hook)) hooks.push(hook);
}

export async function emitDomainEvent(tx: Tx, e: DomainEvent): Promise<void> {
  for (const h of hooks) await h(tx, e);
}
