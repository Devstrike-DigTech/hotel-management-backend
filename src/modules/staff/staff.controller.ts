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
import { ClientIp, CurrentUser, Roles } from '../../common/decorators/index.js';
import { CheckLimit } from '../entitlements/entitlements.decorators.js';
import { CreateStaffDto, UpdateStaffDto } from './staff.dto.js';
import { StaffService } from './staff.service.js';

@ApiTags('Staff')
@ApiBearerAuth()
@Roles('OWNER', 'MANAGER')
@Controller('staff')
export class StaffController {
  constructor(private readonly svc: StaffService) {}

  @Get()
  list(@CurrentUser() user: AuthUser) {
    return this.svc.list(user);
  }

  @Post()
  @CheckLimit('max_staff')
  create(
    @CurrentUser() user: AuthUser,
    @Body() dto: CreateStaffDto,
    @ClientIp() ip?: string,
  ) {
    return this.svc.create(user, dto, ip);
  }

  @Patch(':id')
  update(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateStaffDto,
    @ClientIp() ip?: string,
  ) {
    return this.svc.update(user, id, dto, ip);
  }

  @Delete(':id')
  remove(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @ClientIp() ip?: string,
  ) {
    return this.svc.remove(user, id, ip);
  }
}
