import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import type { AuthUser } from '../../common/auth-types.js';
import {
  ClientIp,
  CurrentUser,
  Roles,
} from '../../common/decorators/index.js';
import { CreateRoomTypeDto, UpdateRoomTypeDto } from './room-types.dto.js';
import { RoomTypesService } from './room-types.service.js';

@ApiTags('Room types')
@ApiBearerAuth()
@Controller('room-types')
export class RoomTypesController {
  constructor(private readonly svc: RoomTypesService) {}

  @Get()
  list(@CurrentUser() user: AuthUser) {
    return this.svc.list(user);
  }

  @Post()
  @Roles('OWNER', 'MANAGER')
  create(
    @CurrentUser() user: AuthUser,
    @Body() dto: CreateRoomTypeDto,
    @ClientIp() ip?: string,
  ) {
    return this.svc.create(user, dto, ip);
  }

  @Patch(':id')
  @Roles('OWNER', 'MANAGER')
  update(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateRoomTypeDto,
    @ClientIp() ip?: string,
  ) {
    return this.svc.update(user, id, dto, ip);
  }

  @Delete(':id')
  @Roles('OWNER', 'MANAGER')
  remove(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @ClientIp() ip?: string,
  ) {
    return this.svc.remove(user, id, ip);
  }
}
