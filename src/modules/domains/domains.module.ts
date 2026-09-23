import { Module } from '@nestjs/common';
import { AppConfigService } from '../../config/app-config.service.js';
import { DNS_RESOLVER, MockDnsResolver, SystemDnsResolver } from './dns.js';
import { DomainsController } from './domains.controller.js';
import { DomainsService } from './domains.service.js';

/** M5 custom domains (feature `custom_domain`). */
@Module({
  controllers: [DomainsController],
  providers: [
    {
      provide: DNS_RESOLVER,
      inject: [AppConfigService],
      useFactory: (c: AppConfigService) => {
        const kind = c.get('DNS_PROVIDER') ?? (c.get('NODE_ENV') === 'production' ? 'system' : 'mock');
        return kind === 'system' ? new SystemDnsResolver() : new MockDnsResolver();
      },
    },
    DomainsService,
  ],
  exports: [DomainsService],
})
export class DomainsModule {}
