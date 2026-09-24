import { Injectable, Logger } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import type { Type } from '@nestjs/common';
import { DunningService } from '../../billing/dunning.service.js';
import { GuestJobsService } from '../../booking/guest-jobs.service.js';
import { HoldsService } from '../../booking/holds.service.js';
import { ControlMirrorService } from '../../dedicated-db/control-mirror.service.js';
import { ListingsService } from '../../dedicated-db/listings.service.js';
import { ProvisioningService } from '../../dedicated-db/provisioning.service.js';
import { ExportsService } from '../../enterprise/exports/exports.service.js';
import { BILLING_QUEUE, GUEST_QUEUE } from '../../jobs/jobs.constants.js';
import { Err } from '../../ops/ops.helpers.js';
import { AnnouncementsService } from './announcements.service.js';
import { OffboardingService } from './offboarding.service.js';
import { JobRunsService, PLATFORM_JOBS, PLATFORM_QUEUE } from './system-health.service.js';

type Runner = (refs: ModuleRef) => Promise<unknown>;

const get = <T>(refs: ModuleRef, t: Type<T>): T => refs.get(t, { strict: false });

/**
 * Named jobs the console can run now (`POST /platform/jobs/:name/run`) and
 * the platform queue's processor runs on schedule. Enterprise services
 * (webhooks, API usage, white-label) register their runners at start-up.
 */
@Injectable()
export class PlatformJobsService {
  private readonly logger = new Logger(PlatformJobsService.name);
  private static readonly extra = new Map<string, { queue: string; run: Runner }>();

  static register(name: string, run: Runner, queue = PLATFORM_QUEUE) {
    PlatformJobsService.extra.set(name, { queue, run });
  }

  private readonly builtIn = new Map<string, { queue: string; run: Runner }>([
    ['dunning', { queue: BILLING_QUEUE, run: (r) => get(r, DunningService).run() }],
    ['holds-sweep', { queue: GUEST_QUEUE, run: (r) => get(r, HoldsService).sweep() }],
    ['guest-notifications', { queue: GUEST_QUEUE, run: (r) => get(r, GuestJobsService).sweep() }],
    [PLATFORM_JOBS.announcementsEmail.name, { queue: PLATFORM_QUEUE, run: (r) => get(r, AnnouncementsService).emailDue() }],
    [
      PLATFORM_JOBS.offboarding.name,
      {
        queue: PLATFORM_QUEUE,
        run: async (r) => {
          const o = get(r, OffboardingService);
          await o.advance();
          return o.runDue();
        },
      },
    ],
    [PLATFORM_JOBS.dedicatedPurge.name, { queue: PLATFORM_QUEUE, run: (r) => get(r, ProvisioningService).purgeDue() }],
    [PLATFORM_JOBS.publicListings.name, { queue: PLATFORM_QUEUE, run: (r) => get(r, ListingsService).refreshAll() }],
    [PLATFORM_JOBS.mirrorSync.name, { queue: PLATFORM_QUEUE, run: async (r) => ({ synced: await get(r, ControlMirrorService).syncAll() }) }],
    [PLATFORM_JOBS.exportsCleanup.name, { queue: PLATFORM_QUEUE, run: (r) => get(r, ExportsService).cleanup() }],
  ]);

  constructor(
    private readonly refs: ModuleRef,
    private readonly runs: JobRunsService,
  ) {}

  names(): string[] {
    return [...new Set([...this.builtIn.keys(), ...PlatformJobsService.extra.keys()])].sort();
  }

  /** Runs a named job now, recording it in the cron table. */
  async run(name: string): Promise<unknown> {
    const j = this.builtIn.get(name) ?? PlatformJobsService.extra.get(name);
    if (!j) throw Err.validation('name', `Unknown job. Use one of: ${this.names().join(', ')}`);
    return this.runs.track(j.queue, name, () => j.run(this.refs));
  }

  /** Scheduled run from the platform queue: never throws for unknown names. */
  async runScheduled(name: string): Promise<unknown> {
    if (!this.builtIn.has(name) && !PlatformJobsService.extra.has(name)) {
      this.logger.warn(`No runner for platform job ${name}`);
      return undefined;
    }
    return this.run(name);
  }
}
