import { Body, Controller, Get, Param, ParseUUIDPipe, Patch, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { IsIn, IsISO8601, IsOptional, IsString, MaxLength } from 'class-validator';
import type { AuthUser } from '../../common/auth-types.js';
import { ClientIp, CurrentUser, Roles } from '../../common/decorators/index.js';
import { RequireFeature } from '../entitlements/entitlements.decorators.js';
import { HousekeepingService } from './housekeeping.service.js';

export class UpdateTaskDto {
  @IsIn(['PENDING', 'IN_PROGRESS', 'DONE']) status!: 'PENDING' | 'IN_PROGRESS' | 'DONE';
  @IsOptional() @IsString() @MaxLength(500) notes?: string;
  @IsOptional() @IsISO8601() clientCreatedAt?: string;
}

export class TaskQueryDto {
  @IsOptional() @IsString() @MaxLength(60) status?: string;
}

@ApiTags('Housekeeping')
@ApiBearerAuth()
@RequireFeature('housekeeping')
@Controller('housekeeping')
export class HousekeepingController {
  constructor(private readonly svc: HousekeepingService) {}

  @Get('tasks')
  @ApiOperation({ summary: 'Cleaning tasks (default: pending and in progress)' })
  tasks(@CurrentUser() user: AuthUser, @Query() q: TaskQueryDto) {
    return this.svc.list(user, q.status);
  }

  @Patch('tasks/:id')
  @Roles('OWNER', 'MANAGER', 'FRONT_DESK', 'HOUSEKEEPING')
  @ApiOperation({ summary: 'Update a task; DONE turns a dirty room clean' })
  update(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateTaskDto, @ClientIp() ip?: string) {
    return this.svc.update(user, id, dto, ip);
  }
}
