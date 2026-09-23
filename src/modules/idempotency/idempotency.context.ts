import { AsyncLocalStorage } from 'node:async_hooks';

/** The Idempotency-Key of the request being handled, if any. */
export interface IdempotencyContext {
  tenantId: string;
  key: string;
}

export const idempotencyContext = new AsyncLocalStorage<IdempotencyContext>();
