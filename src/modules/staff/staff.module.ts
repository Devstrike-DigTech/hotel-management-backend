import { Module } from '@nestjs/common';
import { RolesController } from './roles.controller.js';
import { RolesService } from './roles.service.js';
import { StaffController } from './staff.controller.js';
import { StaffService } from './staff.service.js';

@Module({ controllers: [StaffController, RolesController], providers: [StaffService, RolesService], exports: [RolesService] })
export class StaffModule {}
