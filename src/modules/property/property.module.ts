import { Module } from '@nestjs/common';
import { PropertyController } from './property.controller.js';
import { PropertyService } from './property.service.js';

@Module({ controllers: [PropertyController], providers: [PropertyService] })
export class PropertyModule {}
