import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import type { PlatformPrincipal } from '../../common/auth-types.js';
import { ClientIp, CurrentPlatformUser, PlatformOnly } from '../../common/decorators/index.js';
import { PlatformPermissionRequired } from '../platform/security/platform-permissions.js';
import { ApproveDto, ReasonDto, ReinstateDto, ReviewQueryDto, TenantQueryDto } from './concierge.dto.js';
import { PlatformConciergeService } from './platform-concierge.service.js';

/** Platform console: concierge review queue and per-tenant suspension (M8). */
@ApiTags('Platform concierge')
@ApiBearerAuth()
@PlatformOnly()
@PlatformPermissionRequired('concierge.review')
@Controller('platform/concierge')
export class PlatformConciergeController {
  constructor(private readonly svc: PlatformConciergeService) {}

  @Get('reviews')
  reviews(@Query() q: ReviewQueryDto) {
    return this.svc.reviews(q);
  }

  @Post('tenants/:tenantId/services/:serviceId/approve')
  @HttpCode(200)
  approve(@CurrentPlatformUser() p: PlatformPrincipal, @Param('tenantId', ParseUUIDPipe) tenantId: string, @Param('serviceId', ParseUUIDPipe) serviceId: string, @Body() dto: ApproveDto, @ClientIp() ip?: string) {
    return this.svc.approve(p, tenantId, serviceId, dto.note, ip);
  }

  @Post('tenants/:tenantId/services/:serviceId/reject')
  @HttpCode(200)
  reject(@CurrentPlatformUser() p: PlatformPrincipal, @Param('tenantId', ParseUUIDPipe) tenantId: string, @Param('serviceId', ParseUUIDPipe) serviceId: string, @Body() dto: ReasonDto, @ClientIp() ip?: string) {
    return this.svc.reject(p, tenantId, serviceId, dto.reason, ip);
  }

  @Post('tenants/:tenantId/services/:serviceId/hide')
  @HttpCode(200)
  hide(@CurrentPlatformUser() p: PlatformPrincipal, @Param('tenantId', ParseUUIDPipe) tenantId: string, @Param('serviceId', ParseUUIDPipe) serviceId: string, @Body() dto: ReasonDto, @ClientIp() ip?: string) {
    return this.svc.hide(p, tenantId, serviceId, dto.reason, ip);
  }

  @Get('tenants')
  tenants(@Query() q: TenantQueryDto) {
    return this.svc.tenants({ suspended: q.suspended === undefined ? undefined : q.suspended === 'true', q: q.q, page: q.page, pageSize: q.pageSize });
  }

  @Get('tenants/:tenantId')
  tenant(@Param('tenantId', ParseUUIDPipe) tenantId: string) {
    return this.svc.tenant(tenantId);
  }

  @Post('tenants/:tenantId/suspend')
  @HttpCode(200)
  suspend(@CurrentPlatformUser() p: PlatformPrincipal, @Param('tenantId', ParseUUIDPipe) tenantId: string, @Body() dto: ReasonDto, @ClientIp() ip?: string) {
    return this.svc.suspend(p, tenantId, dto.reason, ip);
  }

  @Post('tenants/:tenantId/reinstate')
  @HttpCode(200)
  reinstate(@CurrentPlatformUser() p: PlatformPrincipal, @Param('tenantId', ParseUUIDPipe) tenantId: string, @Body() dto: ReinstateDto, @ClientIp() ip?: string) {
    return this.svc.reinstate(p, tenantId, dto.note, ip);
  }
}
