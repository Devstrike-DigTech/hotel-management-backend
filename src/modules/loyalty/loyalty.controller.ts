import { Body, Controller, Delete, Get, HttpCode, Param, ParseUUIDPipe, Patch, Post, Put, Query, Res } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import type { AuthUser, GuestPrincipal } from '../../common/auth-types.js';
import { ClientIp, CurrentGuest, CurrentUser, GuestOnly, MaybeGuest, OptionalGuest, Public, RequirePermission } from '../../common/decorators/index.js';
import { PaginationQueryDto } from '../../common/utils/pagination.dto.js';
import { RequireFeature } from '../entitlements/entitlements.decorators.js';
import { AdjustDto, EnrolDto, GuestEnrolDto, MembersQueryDto, ProgrammeDto, RedeemDto, RedeemStartDto, TierDto, UpdateTierDto } from './loyalty.dto.js';
import { LoyaltyService } from './loyalty.service.js';

@ApiTags('Loyalty')
@ApiBearerAuth()
@RequireFeature('loyalty')
@Controller('loyalty')
export class LoyaltyController {
  constructor(private readonly loyalty: LoyaltyService) {}

  @Get('programme') @RequirePermission('loyalty.view')
  programme(@CurrentUser() u: AuthUser) { return this.loyalty.getProgramme(u); }

  @Put('programme') @RequirePermission('loyalty.manage')
  putProgramme(@CurrentUser() u: AuthUser, @Body() dto: ProgrammeDto, @ClientIp() ip?: string) { return this.loyalty.putProgramme(u, dto, ip); }

  @Post('tiers') @RequirePermission('loyalty.manage')
  createTier(@CurrentUser() u: AuthUser, @Body() dto: TierDto, @ClientIp() ip?: string) { return this.loyalty.createTier(u, dto, ip); }

  @Patch('tiers/:id') @RequirePermission('loyalty.manage')
  updateTier(@CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateTierDto, @ClientIp() ip?: string) { return this.loyalty.updateTier(u, id, dto, ip); }

  @Delete('tiers/:id') @RequirePermission('loyalty.manage')
  deleteTier(@CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string, @ClientIp() ip?: string) { return this.loyalty.deleteTier(u, id, ip); }

  @Get('summary') @RequirePermission('loyalty.view')
  summary(@CurrentUser() u: AuthUser) { return this.loyalty.summary(u); }

  @Get('members') @RequirePermission('loyalty.view')
  members(@CurrentUser() u: AuthUser, @Query() q: MembersQueryDto) { return this.loyalty.listMembers(u, q); }

  @Post('members') @RequirePermission('loyalty.view')
  @ApiOperation({ summary: 'Enrol a guest (idempotent: 201 when new, 200 when already a member)' })
  async enrol(@CurrentUser() u: AuthUser, @Body() dto: EnrolDto, @Res({ passthrough: true }) res: Response, @ClientIp() ip?: string) {
    const r = await this.loyalty.enrol(u, dto, ip);
    res.status(r.created ? 201 : 200);
    return r.view;
  }

  @Get('members/by-guest/:guestId') @RequirePermission('loyalty.view')
  byGuest(@CurrentUser() u: AuthUser, @Param('guestId', ParseUUIDPipe) guestId: string) { return this.loyalty.byGuest(u, guestId); }

  @Get('members/:id') @RequirePermission('loyalty.view')
  member(@CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string) { return this.loyalty.getMember(u, id); }

  @Get('members/:id/statement') @RequirePermission('loyalty.view')
  statement(@CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Query() q: PaginationQueryDto) { return this.loyalty.statement(u, id, q); }

  @Post('members/:id/adjust') @RequirePermission('loyalty.adjust') @HttpCode(200)
  adjust(@CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body() dto: AdjustDto, @ClientIp() ip?: string) { return this.loyalty.adjust(u, id, dto, ip); }

  @Post('members/:id/redeem/start') @RequirePermission('loyalty.redeem') @HttpCode(200)
  @ApiOperation({ summary: 'Send the member a 6-digit code to approve a redemption on a folio' })
  redeemStart(@CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body() dto: RedeemStartDto) { return this.loyalty.redeemStart(u, id, dto); }

  @Post('redeem') @RequirePermission('loyalty.redeem') @HttpCode(200)
  @ApiOperation({ summary: 'Redeem with the guest code, or with a manager PIN' })
  redeem(@CurrentUser() u: AuthUser, @Body() dto: RedeemDto, @ClientIp() ip?: string) { return this.loyalty.redeem(u, dto, ip); }

  @Post('jobs/expiry/run') @RequirePermission('loyalty.manage') @HttpCode(200)
  expiry(@CurrentUser() u: AuthUser) { return this.loyalty.expiryNow(u); }
}

@ApiTags('Loyalty')
@Controller()
export class LoyaltyGuestController {
  constructor(private readonly loyalty: LoyaltyService) {}

  @Get('public/hotels/:slug/loyalty')
  @Public()
  @OptionalGuest()
  hotel(@Param('slug') slug: string, @MaybeGuest() g: GuestPrincipal | undefined) { return this.loyalty.publicLoyalty(slug, g); }

  @Get('guest/loyalty')
  @GuestOnly()
  @ApiBearerAuth()
  mine(@CurrentGuest() g: GuestPrincipal) { return this.loyalty.guestLoyalty(g); }

  @Post('guest/loyalty/enrol')
  @GuestOnly()
  @ApiBearerAuth()
  @HttpCode(200)
  enrol(@CurrentGuest() g: GuestPrincipal, @Body() dto: GuestEnrolDto) { return this.loyalty.guestEnrol(g, dto.hotelSlug); }
}
