import { Module } from '@nestjs/common';
import { StaffController } from './staff.controller.js';
import { StaffService } from './staff.service.js';

@Module({ controllers: [StaffController], providers: [StaffService] })
export class StaffModule {}
