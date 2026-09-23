import { Module } from '@nestjs/common';
import { RoomTypesController } from './room-types.controller.js';
import { RoomTypesService } from './room-types.service.js';

@Module({ controllers: [RoomTypesController], providers: [RoomTypesService] })
export class RoomTypesModule {}
