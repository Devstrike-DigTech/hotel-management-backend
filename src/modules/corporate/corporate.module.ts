import { Global, Module } from '@nestjs/common';
import { CorporateController } from './corporate.controller.js';
import { CorporateService } from './corporate.service.js';

/** M4 corporate accounts and the City Ledger (feature `promotions`). */
@Global()
@Module({ controllers: [CorporateController], providers: [CorporateService], exports: [CorporateService] })
export class CorporateModule {}
