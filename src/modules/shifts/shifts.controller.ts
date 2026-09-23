import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Post, Query, Res } from '@nestjs/common';
import type { Response } from 'express';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { AuthUser } from '../../common/auth-types.js';
import { AnyPermission, ClientIp, CurrentUser, RequirePermission } from '../../common/decorators/index.js';
import { RequireFeature } from '../entitlements/entitlements.decorators.js';
import { ApproveShiftDto, CloseShiftDto, OpenShiftDto, ShiftQueryDto } from './shifts.dto.js';
import { ShiftsService } from './shifts.service.js';

@ApiTags('Shifts')
@ApiBearerAuth()
@RequireFeature('front_desk')
@Controller('shifts')
export class ShiftsController {
  constructor(private readonly shifts: ShiftsService) {}

  @Get('current')
  @RequirePermission('shifts.own')
  @ApiOperation({ summary: "The caller's open shift (always blind), or null" })
  async current(@CurrentUser() user: AuthUser, @Res({ passthrough: true }) res: Response) {
    const shift = await this.shifts.current(user);
    if (shift) return shift;
    // Nest sends an empty body for null; the contract promises JSON null.
    res.type('application/json');
    return 'null';
  }

  @Post('open')
  @RequirePermission('shifts.own')
  open(@CurrentUser() user: AuthUser, @Body() dto: OpenShiftDto, @ClientIp() ip?: string) {
    return this.shifts.open(user, dto, ip);
  }

  @Post(':id/close')
  @HttpCode(200)
  @AnyPermission('shifts.own', 'shifts.approve')
  @ApiOperation({ summary: 'Blind close: submit the count, get the variance back' })
  close(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body() dto: CloseShiftDto, @ClientIp() ip?: string) {
    return this.shifts.close(user, id, dto, ip);
  }

  @Post(':id/approve')
  @HttpCode(200)
  @RequirePermission('shifts.approve')
  approve(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body() dto: ApproveShiftDto, @ClientIp() ip?: string) {
    return this.shifts.approve(user, id, dto.notes, ip);
  }

  @Get()
  @AnyPermission('shifts.own', 'shifts.view_all')
  list(@CurrentUser() user: AuthUser, @Query() q: ShiftQueryDto) {
    return this.shifts.list(user, q);
  }

  @Get(':id')
  @AnyPermission('shifts.own', 'shifts.view_all')
  get(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.shifts.get(user, id);
  }
}
