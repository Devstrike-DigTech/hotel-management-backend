import { Body, Controller, Get, HttpCode, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { IsOptional, Matches } from 'class-validator';
import type { AuthUser } from '../../common/auth-types.js';
import { CurrentUser, RequirePermission } from '../../common/decorators/index.js';
import { PaginationQueryDto } from '../../common/utils/pagination.dto.js';
import { NightAuditService } from './night-audit.service.js';

export class RunAuditDto {
  @IsOptional() @Matches(/^\d{4}-\d{2}-\d{2}$/) businessDate?: string;
}

@ApiTags('Night audit')
@ApiBearerAuth()
@Controller('night-audit')
export class NightAuditController {
  constructor(private readonly audit: NightAuditService) {}

  @Get('runs')
  @RequirePermission('reports.view')
  runs(@CurrentUser() user: AuthUser, @Query() q: PaginationQueryDto) {
    return this.audit.list(user, q.page, q.pageSize);
  }

  @Post('run')
  @HttpCode(200)
  @RequirePermission('settings.manage')
  @ApiOperation({ summary: 'Run the night audit now for a past business date (default yesterday); idempotent' })
  run(@CurrentUser() user: AuthUser, @Body() dto: RunAuditDto) {
    return this.audit.runManual(user, dto.businessDate);
  }
}
