import { Injectable, Logger, type Type } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import { ChannelsService } from '../channels/channels.service.js';
import { OtaBookingsService } from '../channels/ota-bookings.service.js';
import { OPS_JOBS } from './jobs.constants.js';

interface Runnable {
  runScheduled?(job: string): Promise<unknown>;
}

/**
 * M5 scheduled work. Services are resolved lazily so the jobs module does
 * not import every Pro module (they are global).
 */
@Injectable()
export class ProJobsService {
  private readonly logger = new Logger(ProJobsService.name);
  /** Extra runners registered by Pro modules (pricing, loyalty, domains). */
  private static readonly runners = new Map<string, Type<Runnable>>();

  static register(job: string, service: Type<Runnable>) {
    ProJobsService.runners.set(job, service);
  }

  constructor(private readonly refs: ModuleRef) {}

  async run(job: string): Promise<unknown> {
    switch (job) {
      case OPS_JOBS.channelAriFlush.name:
        return this.refs.get(ChannelsService, { strict: false }).flushDirty();
      case OPS_JOBS.channelAriSweep.name:
        return this.refs.get(ChannelsService, { strict: false }).sweepAll();
      case OPS_JOBS.icalImport.name:
        return this.refs.get(OtaBookingsService, { strict: false }).importAll();
      default: {
        const t = ProJobsService.runners.get(job);
        if (!t) {
          this.logger.warn(`No runner for ${job}`);
          return undefined;
        }
        return this.refs.get(t, { strict: false }).runScheduled?.(job);
      }
    }
  }
}
