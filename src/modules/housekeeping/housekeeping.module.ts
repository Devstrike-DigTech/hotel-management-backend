import { Module } from '@nestjs/common';
import { HousekeepingController } from './housekeeping.controller.js';

@Module({ controllers: [HousekeepingController] })
export class HousekeepingModule {}
