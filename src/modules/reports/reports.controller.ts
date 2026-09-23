import { Controller, Get, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { IsOptional, IsString, Matches, MaxLength } from 'class-validator';
import { RequireFeature } from '../entitlements/entitlements.decorators.js';
import { GroupReportsService } from './group-reports.service.js';
import type { AuthUser } from '../../common/auth-types.js';
import { CurrentUser, GroupWide, RequirePermission } from '../../common/decorators/index.js';
import { ReportsService } from './reports.service.js';

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export class DailyQueryDto {
  @IsOptional() @Matches(DATE_RE) date?: string;
}

export class RangeQueryDto {
  @Matches(DATE_RE) from!: string;
  @Matches(DATE_RE) to!: string;
}

export class GroupQueryDto extends RangeQueryDto {
  /** Comma-separated property ids (default: every property the user can access). */
  @IsOptional() @IsString() @MaxLength(4000) propertyIds?: string;
}

@ApiTags('Reports')
@ApiBearerAuth()
@RequirePermission('reports.view')
@Controller('reports')
export class ReportsController {
  constructor(
    private readonly reports: ReportsService,
    private readonly group: GroupReportsService,
  ) {}

  @Get('group')
  @GroupWide()
  @RequireFeature('multi_property')
  @ApiOperation({ summary: 'Group report: every accessible property, consolidated and compared (M5)' })
  groupReport(@CurrentUser() user: AuthUser, @Query() q: GroupQueryDto) {
    return this.group.report(user, q.from, q.to, q.propertyIds);
  }

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
