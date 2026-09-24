import { Injectable, Logger } from '@nestjs/common';
import { AppConfigService } from '../../config/app-config.service.js';
import { TenantDbRouter } from '../../prisma/tenant-db-router.js';
import { connect, syncMirror } from './engine.js';

/**
 * Keeps the read-only copy of a dedicated tenant's control-plane rows
 * (tenant, subscription, feature overrides, plan catalogue) in step with the
 * shared database, which stays authoritative. Called after every platform
 * change to those rows and every 5 minutes by a job; failures are logged
 * (entitlement checks read the shared rows anyway).
 */
@Injectable()
export class ControlMirrorService {
  private readonly logger = new Logger(ControlMirrorService.name);

  constructor(
    private readonly router: TenantDbRouter,
    private readonly config: AppConfigService,
  ) {}

  /** Syncs one tenant when it lives in a dedicated database; no-op otherwise. */
  async sync(tenantId: string): Promise<boolean> {
    const route = this.router.dedicated(tenantId);
    if (!route) return false;
    try {
      const src = await connect(this.config.get('DATABASE_PLATFORM_URL'));
      const dst = await connect(this.router.urlsOf(route).platform);
      try {
        await dst.query('BEGIN');
        await syncMirror(src, dst, tenantId);
        await dst.query('COMMIT');
      } catch (e) {
        await dst.query('ROLLBACK').catch(() => undefined);
        throw e;
      } finally {
        await Promise.allSettled([src.end(), dst.end()]);
      }
      return true;
    } catch (e) {
      this.logger.error(`Control mirror sync failed for tenant ${tenantId}: ${(e as Error).message}`);
      return false;
    }
  }

  /** Syncs every dedicated tenant (plan edits touch all of them). */
  async syncAll(): Promise<number> {
    let n = 0;
    for (const r of this.router.activeDedicated()) if (await this.sync(r.tenantId)) n++;
    return n;
  }
}
