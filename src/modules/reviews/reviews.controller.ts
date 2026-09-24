import { PlatformPermissionRequired } from '../platform/security/platform-permissions.js';
import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Patch, Post, Put, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import type { AuthUser, PlatformPrincipal } from '../../common/auth-types.js';
import { ClientIp, CurrentPlatformUser, CurrentUser, PlatformOnly, Public, RequirePermission } from '../../common/decorators/index.js';
import { RateLimit } from '../infra/rate-limit.js';
import {
  FlagReviewDto,
  HotelReviewsQueryDto,
  ModerateReviewDto,
  PlatformReviewsQueryDto,
  PublicReviewsQueryDto,
  ReplyDto,
  ReviewSummaryQueryDto,
  ReviewTokenQueryDto,
  SubmitReviewDto,
} from './reviews.dto.js';
import { ReviewsService } from './reviews.service.js';

@ApiTags('Reviews (public)')
@Public()
@Controller('public')
export class PublicReviewsController {
  constructor(private readonly svc: ReviewsService) {}

  @Get('hotels/:slug/reviews')
  @RateLimit({ name: 'reviews', limit: 120, windowSec: 60 })
  list(@Param('slug') slug: string, @Query() q: PublicReviewsQueryDto) {
    return this.svc.publicList(slug, q);
  }

  @Get('reviews/request')
  request(@Query() q: ReviewTokenQueryDto) {
    return this.svc.requestContext(q.t);
  }

  @Post('reviews')
  @RateLimit({ name: 'review-submit', limit: 10, windowSec: 3600 })
  submit(@Body() dto: SubmitReviewDto, @ClientIp() ip?: string) {
    return this.svc.submit(dto, ip);
  }
}

@ApiTags('Reviews (hotel)')
@ApiBearerAuth()
@Controller('reviews')
export class HotelReviewsController {
  constructor(private readonly svc: ReviewsService) {}

  @Get()
  @RequirePermission('reviews.view')
  list(@CurrentUser() user: AuthUser, @Query() q: HotelReviewsQueryDto) {
    return this.svc.list(user, q);
  }

  @Get('summary')
  @RequirePermission('reviews.view')
  summary(@CurrentUser() user: AuthUser, @Query() q: ReviewSummaryQueryDto) {
    return this.svc.summary(user, q.months ?? 12);
  }

  @Put(':id/reply')
  @RequirePermission('reviews.reply')
  reply(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body() dto: ReplyDto, @ClientIp() ip?: string) {
    return this.svc.reply(user, id, dto.body, ip);
  }

  @Post(':id/flag')
  @HttpCode(200)
  @RequirePermission('reviews.reply')
  flag(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body() dto: FlagReviewDto, @ClientIp() ip?: string) {
    return this.svc.flag(user, id, dto.reason, ip);
  }
}

@ApiTags('Platform reviews')
@ApiBearerAuth()
@PlatformOnly()
@PlatformPermissionRequired('reviews.moderate')
@Controller('platform/reviews')
export class PlatformReviewsController {
  constructor(private readonly svc: ReviewsService) {}

  @Get()
  list(@Query() q: PlatformReviewsQueryDto) {
    return this.svc.platformList(q);
  }

  @Patch(':id')
  moderate(@CurrentPlatformUser() p: PlatformPrincipal, @Param('id', ParseUUIDPipe) id: string, @Body() dto: ModerateReviewDto, @ClientIp() ip?: string) {
    return this.svc.moderate(p, id, dto, ip);
  }
}
