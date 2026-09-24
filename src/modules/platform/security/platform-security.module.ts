import { Global, Module } from '@nestjs/common';
import { ImpersonationGate } from './impersonation-gate.js';
import { PlatformAuditService } from './platform-audit.service.js';
import { PlatformSessionService } from './platform-session.service.js';

/** M6: services the global guards need (platform sessions, audit, impersonation). */
@Global()
@Module({
  providers: [PlatformSessionService, PlatformAuditService, ImpersonationGate],
  exports: [PlatformSessionService, PlatformAuditService, ImpersonationGate],
})
export class PlatformSecurityModule {}
