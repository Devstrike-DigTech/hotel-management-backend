import { Global, Module } from '@nestjs/common';
import { MaintenanceController } from './maintenance.controller.js';
import { MaintenanceService } from './maintenance.service.js';

/** M4 maintenance: tickets, room blocks, preventive schedules, diesel log (feature `maintenance`). */
@Global()
@Module({ controllers: [MaintenanceController], providers: [MaintenanceService], exports: [MaintenanceService] })
export class MaintenanceModule {}
