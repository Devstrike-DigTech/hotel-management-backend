import { Global, Module } from '@nestjs/common';
import { InboxController } from './inbox.controller.js';
import { GuestInboxService } from './inbox.service.js';

/** M5 guest WhatsApp inbox (feature `whatsapp_messaging`). */
@Global()
@Module({
  controllers: [InboxController],
  providers: [GuestInboxService],
  exports: [GuestInboxService],
})
export class InboxModule {}
