import { Global, Module } from '@nestjs/common';
import { PropertiesController, PropertyController } from './property.controller.js';
import { PropertyService } from './property.service.js';

@Global()
@Module({ controllers: [PropertyController, PropertiesController], providers: [PropertyService], exports: [PropertyService] })
export class PropertyModule {}
