import { Global, Module } from '@nestjs/common';
import { AppConfigService } from '../../config/app-config.service.js';
import { CHANNEL_PROVIDER, ChannexProvider, MockChannexProvider } from './channel-provider.js';
import { ChannelsController, ChannelsPublicController } from './channels.controller.js';
import { ChannelsService } from './channels.service.js';
import { OtaBookingsService } from './ota-bookings.service.js';

/** M5 channel manager (feature `channel_manager`). */
@Global()
@Module({
  controllers: [ChannelsController, ChannelsPublicController],
  providers: [
    {
      provide: CHANNEL_PROVIDER,
      inject: [AppConfigService],
      useFactory: (c: AppConfigService) => {
        const key = c.get('CHANNEX_API_KEY');
        if (!key && c.get('NODE_ENV') === 'production') throw new Error('CHANNEX_API_KEY is required in production (the mock Channex is for development)');
        return key ? new ChannexProvider(c.get('CHANNEX_BASE_URL')) : new MockChannexProvider();
      },
    },
    ChannelsService,
    OtaBookingsService,
  ],
  exports: [ChannelsService, OtaBookingsService, CHANNEL_PROVIDER],
})
export class ChannelsModule {}
