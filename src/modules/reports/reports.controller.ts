import { Controller, Get, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { IsOptional, Matches } from 'class-validator';
import type { AuthUser } from '../../common/auth-types.js';
import { CurrentUser, Roles } from '../../common/decorators/index.js';
import { ReportsService } from './reports.service.js';

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export class DailyQueryDto {
  @IsOptional() @Matches(DATE_RE) date?: string;
}

export class RangeQueryDto {
  @Matches(DATE_RE) from!: string;
  @Matches(DATE_RE) to!: string;
}

@ApiTags('Reports')
@ApiBearerAuth()
@Roles('OWNER', 'MANAGER', 'ACCOUNTANT')
@Controller('reports')
export class ReportsController {
  constructor(private readonly reports: ReportsService) {}

  @Get('daily')
  @ApiOperation({ summary: 'Daily flash (night-audit snapshot when available, else live)' })
  daily(@CurrentUser() user: AuthUser, @Query() q: DailyQueryDto) {
    return this.reports.daily(user, q.date);
  }

  @Get('range')
  range(@CurrentUser() user: AuthUser, @Query() q: RangeQueryDto) {
    return this.reports.rangeReport(user, q.from, q.to);
  }

  @Get('payments')
  payments(@CurrentUser() user: AuthUser, @Query() q: RangeQueryDto) {
    return this.reports.payments(user, q.from, q.to);
  }

  @Get('shifts')
  shifts(@CurrentUser() user: AuthUser, @Query() q: RangeQueryDto) {
    return this.reports.shiftReport(user, q.from, q.to);
  }
}
