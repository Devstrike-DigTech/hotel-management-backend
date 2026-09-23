import { Injectable, Logger } from '@nestjs/common';
import type { JobsOptions, Queue } from 'bullmq';

/**
 * Lets request-path services schedule background work without depending on
 * BullMQ being wired: JobsModule registers the guest queue here at start-up.
 * Without it (JOBS_ENABLED=false: tests, scripts) `enqueue` returns false and
 * callers fall back to doing the work inline or leave it to a sweep.
 */
@Injectable()
export class JobsBridge {
  private readonly logger = new Logger(JobsBridge.name);
  private queue: Queue | null = null;

  setQueue(queue: Queue): void {
    this.queue = queue;
  }

  get active(): boolean {
    return this.queue !== null;
  }

  async enqueue(name: string, data: Record<string, unknown>, opts: JobsOptions = {}): Promise<boolean> {
    if (!this.queue) return false;
    try {
      await this.queue.add(name, data, { removeOnComplete: 200, removeOnFail: 500, ...opts });
      return true;
    } catch (e) {
      this.logger.error(`Could not enqueue ${name}: ${(e as Error).message}`);
      return false;
    }
  }

  async remove(jobId: string): Promise<void> {
    if (!this.queue) return;
    try {
      await this.queue.remove(jobId);
    } catch {
      // A job that already ran or is running cannot be removed; it re-checks state anyway.
    }
  }
}
