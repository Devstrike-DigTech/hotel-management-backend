import { Controller, Get, Param, Query } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { Public } from '../../common/decorators/index.js';
import { RateLimit } from '../infra/rate-limit.js';
import { HotelSearchQueryDto, ResolveHostQueryDto } from './public.dto.js';
import { PublicService } from './public.service.js';

@ApiTags('Public')
@Public()
@Controller('public')
export class PublicController {
  constructor(private readonly svc: PublicService) {}

  @Get('app')
  @ApiOperation({ summary: 'Product name, domain and support email' })
  app() {
    return this.svc.app();
  }

  @Get('plans')
  @ApiOperation({ summary: 'Subscription plans, ordered for display' })
  plans() {
    return this.svc.plans();
  }

  @Get('features')
  @ApiOperation({ summary: 'Feature catalogue' })
  features() {
    return this.svc.features();
  }

  @Get('cities')
  @ApiOperation({ summary: 'Cities with at least one listed hotel' })
  cities() {
    return this.svc.cities();
  }

  @Get('hotels')
  @RateLimit({ name: 'search', limit: 120, windowSec: 60 })
  @ApiOperation({ summary: 'Search marketplace hotels' })
  hotels(@Query() q: HotelSearchQueryDto) {
    return this.svc.hotels(q);
  }

  @Get('hotels/:slug')
  @ApiOperation({ summary: 'Hotel detail page' })
  hotel(@Param('slug') slug: string, @Query('host') host?: string) {
    return this.svc.hotel(slug, typeof host === 'string' ? host.slice(0, 253) : undefined);
  }

  @Get('groups/:slug')
  @ApiOperation({ summary: 'A hotel group and its properties (group microsite root, M5)' })
  group(@Param('slug') slug: string, @Query('host') host?: string) {
    return this.svc.groupPage(slug, typeof host === 'string' ? host.slice(0, 253) : undefined);
  }

  @Get('resolve-host')
  @ApiOperation({
    summary: 'Resolve a microsite host (subdomain or custom domain) to a slug',
  })
  resolveHost(@Query() q: ResolveHostQueryDto) {
    return this.svc.resolveHost(q.host ?? q.domain ?? '');
  }
}
