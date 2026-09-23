import { Body, Controller, Delete, Get, HttpCode, Param, ParseUUIDPipe, Patch, Post, Query, UploadedFile, UseInterceptors } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { ApiBearerAuth, ApiConsumes, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { ArrayMaxSize, IsArray, IsBoolean, IsIn, IsInt, IsISO8601, IsNumber, IsOptional, IsString, IsUUID, Matches, Max, MaxLength, Min, MinLength, ValidateIf } from 'class-validator';
import type { AuthUser } from '../../common/auth-types.js';
import { ClientIp, CurrentUser, RequirePermission } from '../../common/decorators/index.js';
import { RequireFeature } from '../entitlements/entitlements.decorators.js';
import type { UploadedFileLike } from '../guests/guests.service.js';
import { MAX_PHOTO_BYTES } from '../storage/photos.js';
import { MaintenanceService } from './maintenance.service.js';

const CATEGORIES = ['ELECTRICAL', 'PLUMBING', 'AC_HVAC', 'FURNITURE', 'APPLIANCE', 'GENERATOR', 'CIVIL', 'IT', 'OTHER'] as const;
const PRIORITIES = ['LOW', 'NORMAL', 'HIGH', 'URGENT'] as const;
const STATUSES = ['OPEN', 'ASSIGNED', 'IN_PROGRESS', 'ON_HOLD', 'RESOLVED', 'CLOSED'] as const;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const MAX = 100_000_000_000;

export class TicketQueryDto {
  @IsOptional() @IsString() @MaxLength(120) status?: string;
  @IsOptional() @IsString() @MaxLength(60) priority?: string;
  @IsOptional() @IsString() @MaxLength(200) category?: string;
  @IsOptional() @IsUUID() roomId?: string;
  @IsOptional() @IsUUID() assigneeId?: string;
  @IsOptional() @IsString() @MaxLength(80) q?: string;
  @IsOptional() @IsString() overdue?: string;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) page?: number;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(100) pageSize?: number;
}

export class CreateTicketDto {
  @IsOptional() @IsUUID() roomId?: string;
  @IsOptional() @IsString() @MaxLength(120) area?: string;
  @IsIn(CATEGORIES) category!: (typeof CATEGORIES)[number];
  @IsOptional() @IsIn(PRIORITIES) priority?: (typeof PRIORITIES)[number];
  @IsString() @MinLength(3) @MaxLength(120) title!: string;
  @IsOptional() @IsString() @MaxLength(2000) description?: string;
  @IsOptional() @IsUUID() assigneeId?: string;
  @IsOptional() @IsString() @MaxLength(120) vendorName?: string;
  @IsOptional() @IsString() @MaxLength(30) vendorPhone?: string;
  @IsOptional() @IsBoolean() blocksRoom?: boolean;
  @IsOptional() @IsISO8601() outOfOrderFrom?: string;
  @IsOptional() @IsISO8601() outOfOrderTo?: string;
  @IsOptional() @IsBoolean() force?: boolean;
  @IsOptional() @IsISO8601() clientCreatedAt?: string;
}

export class UpdateTicketDto {
  @IsOptional() @IsString() @MinLength(3) @MaxLength(120) title?: string;
  @IsOptional() @IsString() @MaxLength(2000) description?: string;
  @IsOptional() @IsIn(CATEGORIES) category?: (typeof CATEGORIES)[number];
  @IsOptional() @IsIn(PRIORITIES) priority?: (typeof PRIORITIES)[number];
  @IsOptional() @ValidateIf((_o, v) => v !== null) @IsUUID() assigneeId?: string | null;
  @IsOptional() @IsString() @MaxLength(120) vendorName?: string;
  @IsOptional() @IsString() @MaxLength(30) vendorPhone?: string;
  @IsOptional() @IsString() @MaxLength(120) area?: string;
}

export class TicketStatusDto {
  @IsIn(STATUSES) status!: (typeof STATUSES)[number];
  @IsOptional() @IsString() @MaxLength(500) note?: string;
  @IsOptional() @IsString() @MaxLength(1000) resolutionNote?: string;
  @IsOptional() @IsInt() @Min(0) @Max(MAX) costKobo?: number;
  @IsOptional() @IsISO8601() clientCreatedAt?: string;
}

export class CommentDto {
  @IsString() @MinLength(1) @MaxLength(1000) body!: string;
}

export class BlockQueryDto {
  @IsOptional() @Matches(DATE) from?: string;
  @IsOptional() @Matches(DATE) to?: string;
  @IsOptional() @IsUUID() roomId?: string;
  @IsOptional() @IsString() active?: string;
}

export class CreateBlockDto {
  @IsUUID() roomId!: string;
  @IsISO8601() from!: string;
  @IsISO8601() to!: string;
  @IsString() @MinLength(2) @MaxLength(200) reason!: string;
  @IsOptional() @IsUUID() ticketId?: string;
  @IsOptional() @IsBoolean() force?: boolean;
}

export class UpdateBlockDto {
  @IsOptional() @IsISO8601() to?: string;
  @IsOptional() @IsString() @MinLength(2) @MaxLength(200) reason?: string;
  @IsOptional() @IsBoolean() force?: boolean;
}

export class ScheduleDto {
  @IsString() @MinLength(3) @MaxLength(120) title!: string;
  @IsIn(CATEGORIES) category!: (typeof CATEGORIES)[number];
  @IsOptional() @IsIn(PRIORITIES) priority?: (typeof PRIORITIES)[number];
  @IsOptional() @IsArray() @ArrayMaxSize(300) @IsUUID('all', { each: true }) roomIds?: string[];
  @IsOptional() @IsString() @MaxLength(120) area?: string;
  @IsInt() @Min(1) @Max(730) everyDays!: number;
  @IsString() @MaxLength(40) nextDueAt!: string;
  @IsOptional() @IsArray() @ArrayMaxSize(40) @IsString({ each: true }) checklist?: string[];
  @IsOptional() @IsBoolean() active?: boolean;
}

export class UpdateScheduleDto {
  @IsOptional() @IsString() @MinLength(3) @MaxLength(120) title?: string;
  @IsOptional() @IsIn(CATEGORIES) category?: (typeof CATEGORIES)[number];
  @IsOptional() @IsIn(PRIORITIES) priority?: (typeof PRIORITIES)[number];
  @IsOptional() @IsArray() @ArrayMaxSize(300) @IsUUID('all', { each: true }) roomIds?: string[];
  @IsOptional() @ValidateIf((_o, v) => v !== null) @IsString() @MaxLength(120) area?: string | null;
  @IsOptional() @IsInt() @Min(1) @Max(730) everyDays?: number;
  @IsOptional() @IsString() @MaxLength(40) nextDueAt?: string;
  @IsOptional() @IsArray() @ArrayMaxSize(40) @IsString({ each: true }) checklist?: string[];
  @IsOptional() @IsBoolean() active?: boolean;
}

export class RangeQueryDto {
  @IsOptional() @Matches(DATE) from?: string;
  @IsOptional() @Matches(DATE) to?: string;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) page?: number;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(100) pageSize?: number;
}

export class FuelDto {
  @IsOptional() @Matches(DATE) date?: string;
  @IsNumber({ maxDecimalPlaces: 1 }) @Min(0.1) @Max(100_000) litres!: number;
  @IsInt() @Min(0) @Max(MAX) costKobo!: number;
  @IsString() @MinLength(2) @MaxLength(120) supplier!: string;
  @IsOptional() @IsNumber({ maxDecimalPlaces: 1 }) @Min(0) @Max(10_000) runHours?: number;
  @IsOptional() @IsString() @MaxLength(80) generator?: string;
  @IsOptional() @IsString() @MaxLength(500) notes?: string;
  @IsOptional() @IsISO8601() clientCreatedAt?: string;
}

export class UpdateFuelDto {
  @IsOptional() @Matches(DATE) date?: string;
  @IsOptional() @IsNumber({ maxDecimalPlaces: 1 }) @Min(0.1) @Max(100_000) litres?: number;
  @IsOptional() @IsInt() @Min(0) @Max(MAX) costKobo?: number;
  @IsOptional() @IsString() @MinLength(2) @MaxLength(120) supplier?: string;
  @IsOptional() @ValidateIf((_o, v) => v !== null) @IsNumber({ maxDecimalPlaces: 1 }) @Min(0) @Max(10_000) runHours?: number | null;
  @IsOptional() @IsString() @MaxLength(80) generator?: string;
  @IsOptional() @IsString() @MaxLength(500) notes?: string;
}

@ApiTags('Maintenance')
@ApiBearerAuth()
@RequireFeature('maintenance')
@Controller()
export class MaintenanceController {
  constructor(private readonly svc: MaintenanceService) {}

  @Get('maintenance/tickets')
  @RequirePermission('maintenance.view')
  list(@CurrentUser() user: AuthUser, @Query() q: TicketQueryDto) {
    return this.svc.list(user, q);
  }

  @Get('maintenance/tickets/:id')
  @RequirePermission('maintenance.view')
  get(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.svc.get(user, id);
  }

  @Post('maintenance/tickets')
  @RequirePermission('maintenance.report')
  create(@CurrentUser() user: AuthUser, @Body() dto: CreateTicketDto, @ClientIp() ip?: string) {
    return this.svc.create(user, dto, ip);
  }

  @Patch('maintenance/tickets/:id')
  @RequirePermission('maintenance.manage')
  update(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateTicketDto, @ClientIp() ip?: string) {
    return this.svc.update(user, id, dto, ip);
  }

  @Post('maintenance/tickets/:id/status')
  @HttpCode(200)
  @RequirePermission('maintenance.view')
  status(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body() dto: TicketStatusDto, @ClientIp() ip?: string) {
    return this.svc.setStatus(user, id, dto, ip);
  }

  @Post('maintenance/tickets/:id/comments')
  @HttpCode(200)
  @RequirePermission('maintenance.report')
  comment(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body() dto: CommentDto) {
    return this.svc.comment(user, id, dto.body);
  }

  @Post('maintenance/tickets/:id/photos')
  @HttpCode(200)
  @RequirePermission('maintenance.report')
  @ApiConsumes('multipart/form-data')
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: MAX_PHOTO_BYTES, files: 1 } }))
  photo(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string, @UploadedFile() file: UploadedFileLike | undefined) {
    return this.svc.addPhoto(user, id, file);
  }

  @Get('room-blocks')
  @RequirePermission('maintenance.view')
  blocks(@CurrentUser() user: AuthUser, @Query() q: BlockQueryDto) {
    return this.svc.listBlocks(user, q);
  }

  @Post('room-blocks')
  @RequirePermission('maintenance.manage')
  @ApiOperation({ summary: 'Block a room (out of order) for a window; 409 BLOCK_CONFLICT lists the bookings in the way' })
  createBlock(@CurrentUser() user: AuthUser, @Body() dto: CreateBlockDto, @ClientIp() ip?: string) {
    return this.svc.createBlock(user, dto, ip);
  }

  @Patch('room-blocks/:id')
  @RequirePermission('maintenance.manage')
  updateBlock(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateBlockDto, @ClientIp() ip?: string) {
    return this.svc.updateBlock(user, id, dto, ip);
  }

  @Delete('room-blocks/:id')
  @RequirePermission('maintenance.manage')
  releaseBlock(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string, @ClientIp() ip?: string) {
    return this.svc.releaseBlock(user, id, ip);
  }

  @Get('maintenance/schedules')
  @RequirePermission('maintenance.view')
  schedules(@CurrentUser() user: AuthUser) {
    return this.svc.listSchedules(user);
  }

  @Get('maintenance/schedules/calendar')
  @RequirePermission('maintenance.view')
  calendar(@CurrentUser() user: AuthUser, @Query() q: RangeQueryDto) {
    return this.svc.scheduleCalendar(user, q);
  }

  @Post('maintenance/schedules/run')
  @HttpCode(200)
  @RequirePermission('maintenance.manage')
  async runSchedules(@CurrentUser() user: AuthUser) {
    return { created: await this.svc.runSchedules(user.tenantId) };
  }

  @Post('maintenance/schedules')
  @RequirePermission('maintenance.manage')
  createSchedule(@CurrentUser() user: AuthUser, @Body() dto: ScheduleDto, @ClientIp() ip?: string) {
    return this.svc.createSchedule(user, dto, ip);
  }

  @Patch('maintenance/schedules/:id')
  @RequirePermission('maintenance.manage')
  updateSchedule(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateScheduleDto, @ClientIp() ip?: string) {
    return this.svc.updateSchedule(user, id, dto, ip);
  }

  @Delete('maintenance/schedules/:id')
  @RequirePermission('maintenance.manage')
  deleteSchedule(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string, @ClientIp() ip?: string) {
    return this.svc.deleteSchedule(user, id, ip);
  }

  @Get('maintenance/fuel-logs')
  @RequirePermission('maintenance.view')
  fuel(@CurrentUser() user: AuthUser, @Query() q: RangeQueryDto) {
    return this.svc.listFuel(user, q);
  }

  @Get('maintenance/fuel-logs/summary')
  @RequirePermission('maintenance.view')
  fuelSummary(@CurrentUser() user: AuthUser, @Query() q: RangeQueryDto) {
    return this.svc.fuelSummary(user, q);
  }

  @Post('maintenance/fuel-logs')
  @RequirePermission('maintenance.work')
  createFuel(@CurrentUser() user: AuthUser, @Body() dto: FuelDto, @ClientIp() ip?: string) {
    return this.svc.createFuel(user, dto, ip);
  }

  @Patch('maintenance/fuel-logs/:id')
  @RequirePermission('maintenance.manage')
  updateFuel(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateFuelDto, @ClientIp() ip?: string) {
    return this.svc.updateFuel(user, id, dto, ip);
  }

  @Delete('maintenance/fuel-logs/:id')
  @RequirePermission('maintenance.manage')
  deleteFuel(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string, @ClientIp() ip?: string) {
    return this.svc.deleteFuel(user, id, ip);
  }

  @Get('maintenance/reports')
  @RequirePermission('maintenance.view')
  reports(@CurrentUser() user: AuthUser, @Query() q: RangeQueryDto) {
    return this.svc.reports(user, q);
  }
}
