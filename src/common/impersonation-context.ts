import { AsyncLocalStorage } from 'node:async_hooks';

/**
 * M6: the support session a hotel request runs under (Devstrike staff signed
 * in as a hotel user). AuditService reads it so every tenant audit row
 * written during the session names the platform user too.
 */
export interface ImpersonationContext {
  sessionId: string;
  platformUserId: string;
  platformUserName: string;
}

export const impersonationContext = new AsyncLocalStorage<ImpersonationContext>();

/**
 * M6: the API key a partner API request runs under; audit rows show
 * "API key <name>" as the actor name.
 */
export interface ApiKeyContext {
  apiKeyId: string;
  name: string;
  environment: 'LIVE' | 'TEST';
}

export const apiKeyContext = new AsyncLocalStorage<ApiKeyContext>();
