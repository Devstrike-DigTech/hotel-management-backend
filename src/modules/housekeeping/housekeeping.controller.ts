import { Body, Controller, Delete, Get, HttpCode, Param, ParseUUIDPipe, Patch, Post, Put, Query, UploadedFile, UseInterceptors } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { ApiBearerAuth, ApiConsumes, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsISO8601,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  Max,
  MaxLength,
  Min,
  MinLength,
  ValidateIf,
  ValidateNested,
} from 'class-validator';
import type { AuthUser } from '../../common/auth-types.js';
import { AnyPermission, ClientIp, CurrentUser, RequirePermission } from '../../common/decorators/index.js';
import { RequireFeature } from '../entitlements/entitlements.decorators.js';
import type { UploadedFileLike } from '../guests/guests.service.js';
import { MaintenanceService } from '../maintenance/maintenance.service.js';
import { MAX_PHOTO_BYTES } from '../storage/photos.js';
import { HousekeepingService } from './housekeeping.service.js';

const TYPES = ['CHECKOUT_CLEAN', 'STAYOVER', 'DEEP_CLEAN', 'TURNDOWN', 'INSPECTION', 'CUSTOM'] as const;
const PRIORITIES = ['LOW', 'NORMAL', 'HIGH', 'URGENT'] as const;
const CATEGORIES = ['ELECTRICAL', 'PLUMBING', 'AC_HVAC', 'FURNITURE', 'APPLIANCE', 'GENERATOR', 'CIVIL', 'IT', 'OTHER'] as const;

export class UpdateTaskDto {
  @IsOptional() @IsIn(['PENDING', 'OPEN', 'IN_PROGRESS', 'DONE']) status?: 'PENDING' | 'OPEN' | 'IN_PROGRESS' | 'DONE';
  @IsOptional() @IsString() @MaxLength(500) notes?: string;
  @IsOptional() @IsISO8601() clientCreatedAt?: string;
  @IsOptional() @IsIn(PRIORITIES) priority?: (typeof PRIORITIES)[number];
  @IsOptional() @ValidateIf((_o, v) => v !== null) @IsUUID() assigneeId?: string | null;
  @IsOptional() @ValidateIf((_o, v) => v !== null) @IsISO8601() dueAt?: string | null;
}

export class TaskQueryDto {
  @IsOptional() @IsString() @MaxLength(120) status?: string;
  @IsOptional() @IsString() @MaxLength(120) type?: string;
  @IsOptional() @IsUUID() assigneeId?: string;
  @IsOptional() @Type(() => Number) @IsInt() floor?: number;
  @IsOptional() @Matches(/^\d{4}-\d{2}-\d{2}$/) date?: string;
  @IsOptional() @IsUUID() roomId?: string;
}

export class CreateTaskDto {
  @IsUUID() roomId!: string;
  @IsIn(TYPES) type!: (typeof TYPES)[number];
  @IsOptional() @IsIn(PRIORITIES) priority?: (typeof PRIORITIES)[number];
  @IsOptional() @IsUUID() assigneeId?: string;
  @IsOptional() @IsISO8601() dueAt?: string;
  @IsOptional() @IsString() @MaxLength(500) notes?: string;
}

export class OfflineDto {
  @IsOptional() @IsISO8601() clientCreatedAt?: string;
}

export class TickDto {
  @IsString() @MaxLength(20) id!: string;
  @IsBoolean() done!: boolean;
}

export class ChecklistTicksDto extends OfflineDto {
  @IsArray() @ArrayMaxSize(60) @ValidateNested({ each: true }) @Type(() => TickDto) items!: TickDto[];
}

export class FinishDto extends OfflineDto {
  @IsOptional() @IsString() @MaxLength(500) notes?: string;
  @IsOptional() @IsArray() @ArrayMaxSize(60) @ValidateNested({ each: true }) @Type(() => TickDto) checklist?: TickDto[];
}

export class SkipDto extends OfflineDto {
  @IsString() @MinLength(2) @MaxLength(200) reason!: string;
}

export class InspectDto extends OfflineDto {
  @IsIn(['PASS', 'FAIL']) result!: 'PASS' | 'FAIL';
  @IsOptional() @IsString() @MaxLength(500) note?: string;
}

export class IssueDto {
  @IsString() @MinLength(3) @MaxLength(120) title!: string;
  @IsIn(CATEGORIES) category!: (typeof CATEGORIES)[number];
  @IsOptional() @IsString() @MaxLength(2000) description?: string;
  @IsOptional() @IsIn(PRIORITIES) priority?: (typeof PRIORITIES)[number];
  @IsOptional() @IsArray() @IsString({ each: true }) photoKeys?: string[];
  @IsOptional() @IsBoolean() blocksRoom?: boolean;
}

export class AssignDto {
  @ValidateIf((_o, v) => v !== null) @IsUUID() assigneeId!: string | null;
  @IsOptional() @IsArray() @ArrayMaxSize(300) @IsUUID('all', { each: true }) taskIds?: string[];
  @IsOptional() @IsInt() @Min(-5) @Max(200) floor?: number;
}

export class AssignmentDto {
  @IsUUID() taskId!: string;
  @IsUUID() assigneeId!: string;
}

export class ApplyAssignmentsDto {
  @IsArray() @ArrayMaxSize(300) @ValidateNested({ each: true }) @Type(() => AssignmentDto) assignments!: AssignmentDto[];
}

export class DeepCleanDto {
  @IsUUID() roomTypeId!: string;
  @ValidateIf((_o, v) => v !== null) @IsInt() @Min(2) @Max(100) every!: number | null;
}

export class HousekeepingSettingsDto {
  @IsOptional() @IsBoolean() requireInspection?: boolean;
  @IsOptional() @IsBoolean() stayoverEnabled?: boolean;
  @IsOptional() @IsArray() @ValidateNested({ each: true }) @Type(() => DeepCleanDto) deepCleanEveryStays?: DeepCleanDto[];
}

export class ChecklistItemDto {
  @IsOptional() @IsString() @MaxLength(20) id?: string;
  @IsString() @MinLength(2) @MaxLength(120) label!: string;
}

export class PutChecklistDto {
  @ValidateIf((_o, v) => v !== null) @IsUUID() roomTypeId!: string | null;
  @IsIn(TYPES) taskType!: (typeof TYPES)[number];
  @IsArray() @ArrayMinSize(1) @ArrayMaxSize(40) @ValidateNested({ each: true }) @Type(() => ChecklistItemDto) items!: ChecklistItemDto[];
}

export class LostQueryDto {
  @IsOptional() @IsString() @MaxLength(60) status?: string;
  @IsOptional() @IsString() @MaxLength(80) q?: string;
  @IsOptional() @Matches(/^\d{4}-\d{2}-\d{2}$/) from?: string;
  @IsOptional() @Matches(/^\d{4}-\d{2}-\d{2}$/) to?: string;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) page?: number;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(100) pageSize?: number;
}

export class CreateLostDto extends OfflineDto {
  @IsString() @MinLength(2) @MaxLength(300) description!: string;
  @IsOptional() @IsString() @MaxLength(40) category?: string;
  @IsOptional() @IsUUID() roomId?: string;
  @IsOptional() @IsString() @MaxLength(120) location?: string;
  @IsOptional() @IsISO8601() foundAt?: string;
  @IsOptional() @IsString() @MaxLength(120) storageLocation?: string;
  @IsOptional() @IsUUID() reservationId?: string;
  @IsOptional() @IsUUID() guestId?: string;
  @IsOptional() @IsString() @MaxLength(500) notes?: string;
}

export class UpdateLostDto {
  @IsOptional() @IsString() @MinLength(2) @MaxLength(300) description?: string;
  @IsOptional() @IsString() @MaxLength(40) category?: string;
  @IsOptional() @IsString() @MaxLength(120) storageLocation?: string;
  @IsOptional() @ValidateIf((_o, v) => v !== null) @IsUUID() guestId?: string | null;
  @IsOptional() @IsString() @MaxLength(500) notes?: string;
  @IsOptional() @IsIn(['HELD', 'RETURNED', 'DISPOSED']) status?: 'HELD' | 'RETURNED' | 'DISPOSED';
  @IsOptional() @IsString() @MaxLength(120) returnedTo?: string;
}

const photo = () => UseInterceptors(FileInterceptor('file', { limits: { fileSize: MAX_PHOTO_BYTES, files: 1 } }));

@ApiTags('Housekeeping')
@ApiBearerAuth()
@RequireFeature('housekeeping')
@Controller('housekeeping')
export class HousekeepingController {
  constructor(
    private readonly svc: HousekeepingService,
    private readonly maintenance: MaintenanceService,
  ) {}

  @Get('tasks')
  @RequirePermission('housekeeping.view')
  @ApiOperation({ summary: 'Cleaning tasks (default: not finished, plus done awaiting inspection)' })
  tasks(@CurrentUser() user: AuthUser, @Query() q: TaskQueryDto) {
    return this.svc.list(user, q);
  }

  @Get('my-tasks')
  @RequirePermission('housekeeping.work')
  @ApiOperation({ summary: "The housekeeper's own rooms for today" })
  mine(@CurrentUser() user: AuthUser) {
    return this.svc.myTasks(user);
  }

  @Get('board')
  @RequirePermission('housekeeping.view')
  board(@CurrentUser() user: AuthUser, @Query('date') date?: string) {
    return this.svc.board(user, date);
  }

  @Get('inspections')
  @RequirePermission('housekeeping.inspect')
  inspections(@CurrentUser() user: AuthUser) {
    return this.svc.inspections(user);
  }

  @Get('tasks/:id')
  @RequirePermission('housekeeping.view')
  get(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.svc.get(user, id);
  }

  @Post('tasks')
  @RequirePermission('housekeeping.assign')
  create(@CurrentUser() user: AuthUser, @Body() dto: CreateTaskDto, @ClientIp() ip?: string) {
    return this.svc.create(user, dto, ip);
  }

  @Patch('tasks/:id')
  @RequirePermission('housekeeping.work')
  @ApiOperation({ summary: 'Update a task (M2 status shape, plus assignment fields for supervisors)' })
  update(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateTaskDto, @ClientIp() ip?: string) {
    return this.svc.update(user, id, dto, ip);
  }

  @Post('tasks/:id/start')
  @HttpCode(200)
  @RequirePermission('housekeeping.work')
  start(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body() dto: OfflineDto, @ClientIp() ip?: string) {
    return this.svc.start(user, id, dto, ip);
  }

  @Put('tasks/:id/checklist')
  @RequirePermission('housekeeping.work')
  checklist(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body() dto: ChecklistTicksDto) {
    return this.svc.checklist(user, id, dto);
  }

  @Post('tasks/:id/finish')
  @HttpCode(200)
  @RequirePermission('housekeeping.work')
  finish(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body() dto: FinishDto, @ClientIp() ip?: string) {
    return this.svc.finish(user, id, dto, ip);
  }

  @Post('tasks/:id/skip')
  @HttpCode(200)
  @RequirePermission('housekeeping.work')
  skip(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body() dto: SkipDto, @ClientIp() ip?: string) {
    return this.svc.skip(user, id, dto, ip);
  }

  @Post('tasks/:id/inspect')
  @HttpCode(200)
  @RequirePermission('housekeeping.inspect')
  inspect(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body() dto: InspectDto, @ClientIp() ip?: string) {
    return this.svc.inspect(user, id, dto, ip);
  }

  @Post('tasks/:id/photos')
  @HttpCode(200)
  @RequirePermission('housekeeping.work')
  @ApiConsumes('multipart/form-data')
  @photo()
  addPhoto(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string, @UploadedFile() file: UploadedFileLike | undefined, @ClientIp() ip?: string) {
    return this.svc.addPhoto(user, id, file, ip);
  }

  @Post('tasks/:id/issue')
  @RequirePermission('maintenance.report')
  @ApiOperation({ summary: 'Report an issue found while cleaning (creates a maintenance ticket)' })
  issue(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body() dto: IssueDto, @ClientIp() ip?: string) {
    return this.maintenance.createFromTask(user, id, dto, ip);
  }

  @Post('assign')
  @HttpCode(200)
  @RequirePermission('housekeeping.assign')
  assign(@CurrentUser() user: AuthUser, @Body() dto: AssignDto, @ClientIp() ip?: string) {
    return this.svc.assign(user, dto, ip);
  }

  @Get('assignments/suggest')
  @RequirePermission('housekeeping.assign')
  @ApiOperation({ summary: 'Auto-balance suggestion (minutes per housekeeper)' })
  suggest(@CurrentUser() user: AuthUser) {
    return this.svc.suggest(user);
  }

  @Post('assignments/apply')
  @HttpCode(200)
  @RequirePermission('housekeeping.assign')
  apply(@CurrentUser() user: AuthUser, @Body() dto: ApplyAssignmentsDto, @ClientIp() ip?: string) {
    return this.svc.applyAssignments(user, dto, ip);
  }

  @Get('settings')
  @RequirePermission('housekeeping.view')
  settings(@CurrentUser() user: AuthUser) {
    return this.svc.settings(user);
  }

  @Put('settings')
  @AnyPermission('settings.manage', 'housekeeping.assign')
  putSettings(@CurrentUser() user: AuthUser, @Body() dto: HousekeepingSettingsDto, @ClientIp() ip?: string) {
    return this.svc.putSettings(user, dto, ip);
  }

  @Get('checklists')
  @RequirePermission('housekeeping.view')
  checklists(@CurrentUser() user: AuthUser) {
    return this.svc.listChecklists(user);
  }

  @Put('checklists')
  @RequirePermission('housekeeping.assign')
  putChecklist(@CurrentUser() user: AuthUser, @Body() dto: PutChecklistDto, @ClientIp() ip?: string) {
    return this.svc.putChecklist(user, dto, ip);
  }

  @Delete('checklists/:id')
  @RequirePermission('housekeeping.assign')
  deleteChecklist(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string, @ClientIp() ip?: string) {
    return this.svc.deleteChecklist(user, id, ip);
  }

  @Post('jobs/stayover/run')
  @HttpCode(200)
  @RequirePermission('housekeeping.assign')
  async stayover(@CurrentUser() user: AuthUser) {
    return { created: await this.svc.runStayover(user.tenantId, `Stayover run by ${user.fullName}`) };
  }
}

@ApiTags('Housekeeping')
@ApiBearerAuth()
@RequireFeature('housekeeping')
@Controller('lost-found')
export class LostFoundController {
  constructor(private readonly svc: HousekeepingService) {}

  @Get()
  @RequirePermission('housekeeping.view')
  list(@CurrentUser() user: AuthUser, @Query() q: LostQueryDto) {
    return this.svc.listLost(user, q);
  }

  @Post()
  @RequirePermission('housekeeping.work')
  create(@CurrentUser() user: AuthUser, @Body() dto: CreateLostDto, @ClientIp() ip?: string) {
    return this.svc.createLost(user, dto, ip);
  }

  @Patch(':id')
  @RequirePermission('housekeeping.work')
  update(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateLostDto, @ClientIp() ip?: string) {
    return this.svc.updateLost(user, id, dto, ip);
  }

  @Post(':id/photos')
  @HttpCode(200)
  @RequirePermission('housekeeping.work')
  @ApiConsumes('multipart/form-data')
  @photo()
  addPhoto(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string, @UploadedFile() file: UploadedFileLike | undefined, @ClientIp() ip?: string) {
    return this.svc.addLostPhoto(user, id, file, ip);
  }
}
