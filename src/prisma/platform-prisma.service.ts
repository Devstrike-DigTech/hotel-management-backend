import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../generated/prisma/client.js';
import { AppConfigService } from '../config/app-config.service.js';

/**
 * Second Prisma client, connected as `hotel_platform` (DATABASE_PLATFORM_URL).
 *
 * `hotel_platform` is NOSUPERUSER NOBYPASSRLS; its cross-tenant access comes
 * from RLS policies granted `TO hotel_platform`. Only the platform console,
 * the Paystack webhook, dunning and the schedulers that enumerate tenants use
 * it, always through `DbService.system()`. Audit with `grep -rn "\.system(" src`.
 *
 * At start-up it installs DB_CONTEXT_SECRET into the private key store so the
 * database can verify the signed tenant context set by `DbService.tenant()`.
 */
@Injectable()
export class PlatformPrismaService
  extends PrismaClient
  implements OnModuleInit, OnModuleDestroy
{
  private readonly logger = new Logger(PlatformPrismaService.name);

  constructor(private readonly config: AppConfigService) {
    super({
      adapter: new PrismaPg({
        connectionString: config.get('DATABASE_PLATFORM_URL'),
        max: config.get('DATABASE_PLATFORM_POOL_MAX'),
      }),
    });
  }

  async onModuleInit(): Promise<void> {
    await this.$connect();
    await this.$executeRaw`SELECT app_install_context_key(${this.config.get('DB_CONTEXT_SECRET')})`;
    this.logger.log('Platform connection ready; tenant context key installed');
  }

  async onModuleDestroy(): Promise<void> {
    await this.$disconnect();
  }
}
