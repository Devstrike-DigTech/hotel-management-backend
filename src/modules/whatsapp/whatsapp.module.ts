import { Global, Module } from '@nestjs/common';
import { AlertsService } from './alerts.service.js';
import { WhatsAppInboundService } from './inbound.service.js';
import { WhatsAppController, WhatsAppWebhookController } from './whatsapp.controller.js';

/** M4 WhatsApp: template registry, owner alerts for HIGH flags, inbound commands, notification settings. */
@Global()
@Module({
  controllers: [WhatsAppController, WhatsAppWebhookController],
  providers: [AlertsService, WhatsAppInboundService],
  exports: [AlertsService],
})
export class WhatsAppModule {}
