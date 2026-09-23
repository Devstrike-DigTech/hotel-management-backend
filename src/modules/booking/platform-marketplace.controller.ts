import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { IsOptional, IsString, IsUUID, Matches, MaxLength } from 'class-validator';
import type { PlatformPrincipal } from '../../common/auth-types.js';
import { ClientIp, CurrentPlatformUser, PlatformOnly } from '../../common/decorators/index.js';
import { PaginationQueryDto } from '../../common/utils/pagination.dto.js';
import { NotificationQueryDto } from './booking.dto.js';
import { GuestJobsService } from './guest-jobs.service.js';
import { HoldsService } from './holds.service.js';
import { PlatformMarketplaceService } from './platform-marketplace.service.js';

class SummaryQueryDto {
  @IsOptional() @Matches(/^\d{4}-\d{2}-\d{2}$/) from?: string;
  @IsOptional() @Matches(/^\d{4}-\d{2}-\d{2}$/) to?: string;
}

class MonthQueryDto {
  @IsOptional() @Matches(/^\d{4}-\d{2}$/, { message: 'month must be YYYY-MM' }) month?: string;
}

class SettleDto {
  @IsUUID() tenantId!: string;
  @Matches(/^\d{4}-\d{2}$/, { message: 'month must be YYYY-MM' }) month!: string;
  @IsOptional() @IsString() @MaxLength(120) reference?: string;
}

class OrphanQueryDto extends PaginationQueryDto {
  @IsOptional() @Matches(/^(open|all)$/) status?: 'open' | 'all';
}

@ApiTags('Platform marketplace')
@ApiBearerAuth()
@PlatformOnly()
@Controller('platform')
export class PlatformMarketplaceController {
  constructor(
    private readonly svc: PlatformMarketplaceService,
    private readonly holds: HoldsService,
    private readonly guestJobs: GuestJobsService,
  ) {}

  @Get('marketplace/summary')
  summary(@Query() q: SummaryQueryDto) {
    return this.svc.summary(q);
  }

  @Get('commission/receivables')
  receivables(@Query() q: MonthQueryDto) {
    return this.svc.receivables(q.month);
  }

  @Post('commission/receivables/settle')
  @HttpCode(200)
  settle(@CurrentPlatformUser() p: PlatformPrincipal, @Body() dto: SettleDto, @ClientIp() ip?: string) {
    return this.svc.settle(p, dto, ip);
  }

  @Get('payments/orphaned')
  orphaned(@Query() q: OrphanQueryDto) {
    return this.svc.orphaned(q);
  }

  @Post('payments/:id/retry-refund')
  @HttpCode(200)
  retryRefund(@CurrentPlatformUser() p: PlatformPrincipal, @Param('id', ParseUUIDPipe) id: string, @ClientIp() ip?: string) {
    return this.svc.retryRefund(p, id, ip);
  }

  @Get('notifications')
  notifications(@Query() q: NotificationQueryDto) {
    return this.svc.notifications(q);
  }

  @Post('jobs/holds/sweep')
  @HttpCode(200)
  sweepHolds() {
    return this.holds.sweep();
  }

  @Post('jobs/guest-notifications/run')
  @HttpCode(200)
  runGuestNotifications() {
    return this.guestJobs.sweep();
  }
}
