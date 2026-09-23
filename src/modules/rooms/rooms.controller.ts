import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { AuthUser } from '../../common/auth-types.js';
import {
  ClientIp,
  CurrentUser,
  Roles,
} from '../../common/decorators/index.js';
import { CheckLimit } from '../entitlements/entitlements.decorators.js';
import {
  BulkCreateRoomsDto,
  CreateRoomDto,
  RoomQueryDto,
  UpdateRoomDto,
  UpdateRoomStatusDto,
} from './rooms.dto.js';
import { RoomsService } from './rooms.service.js';

@ApiTags('Rooms')
@ApiBearerAuth()
@Controller('rooms')
export class RoomsController {
  constructor(private readonly svc: RoomsService) {}

  @Get()
  list(@CurrentUser() user: AuthUser, @Query() q: RoomQueryDto) {
    return this.svc.list(user, q);
  }

  @Post()
  @Roles('OWNER', 'MANAGER')
  @CheckLimit('max_rooms')
  create(
    @CurrentUser() user: AuthUser,
    @Body() dto: CreateRoomDto,
    @ClientIp() ip?: string,
  ) {
    return this.svc.create(user, dto, ip);
  }

  @Post('bulk')
  @Roles('OWNER', 'MANAGER')
  @CheckLimit('max_rooms')
  @ApiOperation({
    summary: 'Create a numbered range of rooms, e.g. 101-110 on floor 1',
  })
  bulk(
    @CurrentUser() user: AuthUser,
    @Body() dto: BulkCreateRoomsDto,
    @ClientIp() ip?: string,
  ) {
    return this.svc.bulkCreate(user, dto, ip);
  }

  @Patch(':id')
  @Roles('OWNER', 'MANAGER')
  update(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateRoomDto,
    @ClientIp() ip?: string,
  ) {
    return this.svc.update(user, id, dto, ip);
  }

  @Patch(':id/status')
  @Roles('OWNER', 'MANAGER', 'FRONT_DESK', 'HOUSEKEEPING')
  setStatus(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateRoomStatusDto,
    @ClientIp() ip?: string,
  ) {
    return this.svc.setStatus(user, id, dto, ip);
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
