import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Put,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { PropertyAccessDto } from '../property/property.dto.js';
import type { AuthUser } from '../../common/auth-types.js';
import { ClientIp, CurrentUser, GroupWide, RequirePermission } from '../../common/decorators/index.js';
import { CheckLimit } from '../entitlements/entitlements.decorators.js';
import { CreateStaffDto, UpdateStaffDto } from './staff.dto.js';
import { StaffService } from './staff.service.js';

@ApiTags('Staff')
@ApiBearerAuth()
@RequirePermission('staff.manage')
@GroupWide()
@Controller('staff')
export class StaffController {
  constructor(private readonly svc: StaffService) {}

  @Get('approvers')
  @RequirePermission('folio.discount')
  approvers(@CurrentUser() user: AuthUser) {
    return this.svc.approvers(user);
  }

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

  @Put(':id/property-access')
  @ApiOperation({ summary: 'Which properties of the group the staff member can access (M5)' })
  setAccess(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: PropertyAccessDto,
    @ClientIp() ip?: string,
  ) {
    return this.svc.setAccess(user, id, dto, ip);
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
