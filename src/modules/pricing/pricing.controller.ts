import { Body, Controller, Delete, Get, HttpCode, Param, ParseUUIDPipe, Patch, Post, Put, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { AuthUser } from '../../common/auth-types.js';
import { ClientIp, CurrentUser, RequirePermission } from '../../common/decorators/index.js';
import { RequireFeature } from '../entitlements/entitlements.decorators.js';
import { DynamicPricingService } from './dynamic-pricing.service.js';
import {
  AcceptDto,
  BulkDto,
  ChangesQueryDto,
  CompetitorsDto,
  CreateEventDto,
  FrozenDto,
  GuardrailDto,
  PatchEventDto,
  PreviewQueryDto,
  RangeQueryDto,
  RejectDto,
  SettingsDto,
  SuggestionsQueryDto,
} from './pricing.dto.js';

@ApiTags('Dynamic pricing')
@ApiBearerAuth()
@RequireFeature('dynamic_pricing')
@Controller('pricing')
export class PricingController {
  constructor(private readonly pricing: DynamicPricingService) {}

  @Get('settings') @RequirePermission('pricing.view')
  settings(@CurrentUser() u: AuthUser) { return this.pricing.getSettings(u); }

  @Put('settings') @RequirePermission('pricing.manage')
  putSettings(@CurrentUser() u: AuthUser, @Body() dto: SettingsDto, @ClientIp() ip?: string) { return this.pricing.putSettings(u, dto, ip); }

  @Get('guardrails') @RequirePermission('pricing.view')
  guardrails(@CurrentUser() u: AuthUser) { return this.pricing.listGuardrails(u); }

  @Put('guardrails/:roomTypeId') @RequirePermission('pricing.manage')
  putGuardrail(@CurrentUser() u: AuthUser, @Param('roomTypeId', ParseUUIDPipe) id: string, @Body() dto: GuardrailDto, @ClientIp() ip?: string) { return this.pricing.putGuardrail(u, id, dto, ip); }

  @Get('frozen-dates') @RequirePermission('pricing.view')
  frozen(@CurrentUser() u: AuthUser, @Query() q: RangeQueryDto) { return this.pricing.listFrozen(u, q); }

  @Post('frozen-dates') @RequirePermission('pricing.manage')
  addFrozen(@CurrentUser() u: AuthUser, @Body() dto: FrozenDto, @ClientIp() ip?: string) { return this.pricing.addFrozen(u, dto, ip); }

  @Delete('frozen-dates/:id') @RequirePermission('pricing.manage')
  removeFrozen(@CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string, @ClientIp() ip?: string) { return this.pricing.removeFrozen(u, id, ip); }

  @Get('events') @RequirePermission('pricing.view')
  events(@CurrentUser() u: AuthUser, @Query() q: RangeQueryDto) { return this.pricing.listEvents(u, q); }

  @Post('events') @RequirePermission('pricing.manage')
  createEvent(@CurrentUser() u: AuthUser, @Body() dto: CreateEventDto, @ClientIp() ip?: string) { return this.pricing.createEvent(u, dto, ip); }

  @Patch('events/:id') @RequirePermission('pricing.manage')
  @ApiOperation({ summary: 'Custom events: any field. National holidays ("national:<key>-<year>"): disabled and upliftBps only' })
  patchEvent(@CurrentUser() u: AuthUser, @Param('id') id: string, @Body() dto: PatchEventDto, @ClientIp() ip?: string) {
    const body = id.startsWith('national:') ? { disabled: dto.disabled, upliftBps: dto.upliftBps } : dto;
    return this.pricing.patchEvent(u, id, body, ip);
  }

  @Delete('events/:id') @RequirePermission('pricing.manage')
  async deleteEvent(@CurrentUser() u: AuthUser, @Param('id') id: string, @ClientIp() ip?: string) {
    if (!id.startsWith('national:')) await new ParseUUIDPipe().transform(id, { type: 'param' });
    return this.pricing.deleteEvent(u, id, ip);
  }

  @Get('competitors') @RequirePermission('pricing.view')
  competitors(@CurrentUser() u: AuthUser, @Query() q: RangeQueryDto) { return this.pricing.listCompetitors(u, q); }

  @Put('competitors') @RequirePermission('pricing.manage')
  putCompetitors(@CurrentUser() u: AuthUser, @Body() dto: CompetitorsDto, @ClientIp() ip?: string) { return this.pricing.putCompetitors(u, dto.entries, ip); }

  @Delete('competitors/:id') @RequirePermission('pricing.manage')
  removeCompetitor(@CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string) { return this.pricing.removeCompetitor(u, id); }

  @Get('suggestions') @RequirePermission('pricing.view')
  suggestions(@CurrentUser() u: AuthUser, @Query() q: SuggestionsQueryDto) { return this.pricing.listSuggestions(u, q); }

  @Post('run') @RequirePermission('pricing.manage') @HttpCode(200)
  @ApiOperation({ summary: 'Generate suggestions now (autopilot: apply them within the guardrails)' })
  run(@CurrentUser() u: AuthUser, @Body() dto: RangeQueryDto) { return this.pricing.run(u, dto); }

  @Post('suggestions/bulk') @RequirePermission('pricing.manage') @HttpCode(200)
  bulk(@CurrentUser() u: AuthUser, @Body() dto: BulkDto) { return this.pricing.bulk(u, dto); }

  @Post('suggestions/:id/accept') @RequirePermission('pricing.manage') @HttpCode(200)
  accept(@CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body() dto: AcceptDto) { return this.pricing.accept(u, id, dto); }

  @Post('suggestions/:id/reject') @RequirePermission('pricing.manage') @HttpCode(200)
  reject(@CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body() dto: RejectDto) { return this.pricing.reject(u, id, dto); }

  @Get('changes') @RequirePermission('pricing.view')
  changes(@CurrentUser() u: AuthUser, @Query() q: ChangesQueryDto) { return this.pricing.listChanges(u, q); }

  @Post('changes/:id/revert') @RequirePermission('pricing.manage') @HttpCode(200)
  revert(@CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string, @ClientIp() ip?: string) { return this.pricing.revert(u, id, ip); }

  @Get('preview') @RequirePermission('pricing.view')
  preview(@CurrentUser() u: AuthUser, @Query() q: PreviewQueryDto) { return this.pricing.preview(u, q); }

  @Get('report') @RequirePermission('pricing.view')
  report(@CurrentUser() u: AuthUser, @Query() q: RangeQueryDto) { return this.pricing.report(u, q); }
}
