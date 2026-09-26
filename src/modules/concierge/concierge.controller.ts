import { Body, Controller, Delete, Get, HttpCode, Param, ParseUUIDPipe, Patch, Post, Put, Query, Res } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import type { AuthUser } from '../../common/auth-types.js';
import { AnyPermission, ClientIp, CurrentUser, RequirePermission } from '../../common/decorators/index.js';
import { RequireFeature } from '../entitlements/entitlements.decorators.js';
import { CatalogueService, type ServiceInput } from './catalogue.service.js';
import { ConciergeService } from './concierge.service.js';
import {
  AcceptAupDto,
  ConciergeAssignDto,
  ConciergeConfirmDto,
  CreateServiceDto,
  CreateVendorDto,
  ExportQueryDto,
  ConciergeFlagReviewDto,
  FromMessageDto,
  ConciergeNoteDto,
  PriceDto,
  ConciergeQuoteDto,
  RateVendorDto,
  ReportQueryDto,
  RequestQueryDto,
  ScreenDto,
  SendToVendorDto,
  ServiceQueryDto,
  ConciergeSettingsDto,
  ConciergeSettleDto,
  SlotsQueryDto,
  StaffCreateRequestDto,
  StatusDto,
  UpdateRequestDto,
  UpdateServiceDto,
  UpdateVendorDto,
  VendorQueryDto,
} from './concierge.dto.js';
import { RequestsService } from './requests.service.js';

const bool = (v: string | undefined) => (v === undefined ? undefined : v === 'true');

/** Every plan: the admin shows a locked preview and the policy text on Starter. */
@ApiTags('Concierge')
@ApiBearerAuth()
@Controller('concierge')
export class ConciergeGatesController {
  constructor(private readonly core: ConciergeService) {}

  @Get('gates')
  gates(@CurrentUser() u: AuthUser) {
    return this.core.gates(u);
  }

  @Get('aup')
  aup(@CurrentUser() u: AuthUser) {
    return this.core.aup(u);
  }

  @Post('aup/accept') @RequirePermission('concierge.settings') @HttpCode(200)
  accept(@CurrentUser() u: AuthUser, @Body() dto: AcceptAupDto, @ClientIp() ip?: string) {
    return this.core.acceptAup(u, dto.version, ip);
  }
}

@ApiTags('Concierge')
@ApiBearerAuth()
@RequireFeature('concierge')
@Controller('concierge')
export class ConciergeController {
  constructor(
    private readonly core: ConciergeService,
    private readonly catalogue: CatalogueService,
    private readonly requests: RequestsService,
  ) {}

  // --- Settings, catalogue helpers ---------------------------------------------

  @Get('settings') @AnyPermission('concierge.view', 'concierge.settings')
  settings(@CurrentUser() u: AuthUser) {
    return this.core.getSettings(u);
  }

  @Put('settings') @RequirePermission('concierge.settings')
  updateSettings(@CurrentUser() u: AuthUser, @Body() dto: ConciergeSettingsDto, @ClientIp() ip?: string) {
    return this.core.updateSettings(u, dto, ip);
  }

  @Get('categories') @AnyPermission('concierge.view', 'concierge.catalogue')
  categories() {
    return this.catalogue.categories();
  }

  @Get('question-library') @RequirePermission('concierge.catalogue')
  library() {
    return this.catalogue.questionLibrary();
  }

  @Post('screen') @RequirePermission('concierge.catalogue') @HttpCode(200)
  screen(@Body() dto: ScreenDto) {
    return this.catalogue.screen(dto.texts);
  }

  // --- Services -------------------------------------------------------------------

  @Get('services') @AnyPermission('concierge.view', 'concierge.catalogue')
  services(@CurrentUser() u: AuthUser, @Query() q: ServiceQueryDto) {
    return this.catalogue.listServices(u, { active: bool(q.active), category: q.category, reviewStatus: q.reviewStatus });
  }

  @Get('services/:id') @AnyPermission('concierge.view', 'concierge.catalogue')
  service(@CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.catalogue.getService(u, id);
  }

  @Post('services') @RequirePermission('concierge.catalogue')
  createService(@CurrentUser() u: AuthUser, @Body() dto: CreateServiceDto, @ClientIp() ip?: string) {
    return this.catalogue.createService(u, dto as unknown as ServiceInput & { name: string; pricing: string; category: string }, ip);
  }

  @Patch('services/:id') @RequirePermission('concierge.catalogue')
  updateService(@CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateServiceDto, @ClientIp() ip?: string) {
    return this.catalogue.updateService(u, id, dto as unknown as ServiceInput, ip);
  }

  @Delete('services/:id') @RequirePermission('concierge.catalogue')
  removeService(@CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string, @ClientIp() ip?: string) {
    return this.catalogue.removeService(u, id, ip);
  }

  @Get('services/:id/slots') @AnyPermission('concierge.view', 'concierge.work')
  slots(@CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Query() q: SlotsQueryDto) {
    return this.catalogue.slots(u, id, q.date ?? '', q.variantId);
  }

  @Post('price') @AnyPermission('concierge.view', 'concierge.work') @HttpCode(200)
  price(@CurrentUser() u: AuthUser, @Body() dto: PriceDto) {
    return this.catalogue.price(u, dto);
  }

  // --- Vendors ----------------------------------------------------------------------

  @Get('vendors') @AnyPermission('concierge.catalogue', 'concierge.work')
  vendors(@CurrentUser() u: AuthUser, @Query() q: VendorQueryDto) {
    return this.catalogue.listVendors(u, { active: bool(q.active), category: q.category });
  }

  @Get('vendors/:id') @AnyPermission('concierge.catalogue', 'concierge.work')
  vendor(@CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.catalogue.getVendor(u, id);
  }

  @Post('vendors') @RequirePermission('concierge.catalogue')
  createVendor(@CurrentUser() u: AuthUser, @Body() dto: CreateVendorDto, @ClientIp() ip?: string) {
    return this.catalogue.createVendor(u, dto, ip);
  }

  @Patch('vendors/:id') @RequirePermission('concierge.catalogue')
  updateVendor(@CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateVendorDto, @ClientIp() ip?: string) {
    return this.catalogue.updateVendor(u, id, dto, ip);
  }

  @Delete('vendors/:id') @RequirePermission('concierge.catalogue')
  removeVendor(@CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string, @ClientIp() ip?: string) {
    return this.catalogue.removeVendor(u, id, ip);
  }

  @Post('vendors/:id/settle') @RequirePermission('concierge.reports') @HttpCode(200)
  settle(@CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body() dto: ConciergeSettleDto, @ClientIp() ip?: string) {
    return this.catalogue.settle(u, id, dto, ip);
  }

  // --- Requests ------------------------------------------------------------------

  @Get('board') @RequirePermission('concierge.view')
  board(@CurrentUser() u: AuthUser) {
    return this.requests.board(u);
  }

  @Get('today') @RequirePermission('concierge.view')
  today(@CurrentUser() u: AuthUser) {
    return this.requests.today(u);
  }

  @Get('reports') @RequirePermission('concierge.reports')
  reports(@CurrentUser() u: AuthUser, @Query() q: ReportQueryDto) {
    return this.requests.reports(u, q);
  }

  @Get('requests/export') @RequirePermission('concierge.reports')
  async export(@CurrentUser() u: AuthUser, @Query() q: ExportQueryDto, @Res() res: Response, @ClientIp() ip?: string) {
    const out = await this.requests.export(u, q, ip);
    res.setHeader('Content-Type', out.contentType);
    res.setHeader('Content-Disposition', `attachment; filename="${out.filename}"`);
    res.send(out.body);
  }

  @Get('requests') @RequirePermission('concierge.view')
  list(@CurrentUser() u: AuthUser, @Query() q: RequestQueryDto) {
    return this.requests.list(u, {
      status: q.status, source: q.source, from: q.from, to: q.to, q: q.q, assigneeId: q.assigneeId, vendorId: q.vendorId, serviceId: q.serviceId,
      reservationId: q.reservationId, discreet: bool(q.discreet), flagged: bool(q.flagged), overdue: bool(q.overdue), page: q.page, pageSize: q.pageSize,
    });
  }

  @Post('requests') @RequirePermission('concierge.work')
  create(@CurrentUser() u: AuthUser, @Body() dto: StaffCreateRequestDto, @ClientIp() ip?: string) {
    return this.requests.createForGuest(u, dto, ip);
  }

  @Post('requests/from-message') @RequirePermission('concierge.work', 'inbox.view')
  fromMessage(@CurrentUser() u: AuthUser, @Body() dto: FromMessageDto) {
    return this.requests.fromMessage(u, dto);
  }

  @Get('requests/:id') @RequirePermission('concierge.view')
  detail(@CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string, @ClientIp() ip?: string) {
    return this.requests.detail(u, id, { ip });
  }

  @Patch('requests/:id') @RequirePermission('concierge.work')
  update(@CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateRequestDto, @ClientIp() ip?: string) {
    return this.requests.update(u, id, dto, ip);
  }

  @Post('requests/:id/quote') @RequirePermission('concierge.work') @HttpCode(200)
  quote(@CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body() dto: ConciergeQuoteDto, @ClientIp() ip?: string) {
    return this.requests.quote(u, id, dto, ip);
  }

  @Post('requests/:id/confirm') @RequirePermission('concierge.work') @HttpCode(200)
  confirm(@CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body() dto: ConciergeConfirmDto, @ClientIp() ip?: string) {
    return this.requests.confirm(u, id, dto, ip);
  }

  @Post('requests/:id/assign') @RequirePermission('concierge.work') @HttpCode(200)
  assign(@CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body() dto: ConciergeAssignDto, @ClientIp() ip?: string) {
    return this.requests.assign(u, id, dto, ip);
  }

  @Post('requests/:id/send-to-vendor') @RequirePermission('concierge.work') @HttpCode(200)
  sendToVendor(@CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body() dto: SendToVendorDto, @ClientIp() ip?: string) {
    return this.requests.sendToVendor(u, id, dto, ip);
  }

  @Post('requests/:id/status') @RequirePermission('concierge.work') @HttpCode(200)
  status(@CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body() dto: StatusDto, @ClientIp() ip?: string) {
    return this.requests.status(u, id, dto, ip);
  }

  @Post('requests/:id/notes') @RequirePermission('concierge.work') @HttpCode(200)
  note(@CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body() dto: ConciergeNoteDto, @ClientIp() ip?: string) {
    return this.requests.note(u, id, dto.note, ip);
  }

  @Post('requests/:id/flag-review') @RequirePermission('concierge.review') @HttpCode(200)
  flagReview(@CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body() dto: ConciergeFlagReviewDto, @ClientIp() ip?: string) {
    return this.requests.flagReview(u, id, dto, ip);
  }

  @Post('requests/:id/rate-vendor') @RequirePermission('concierge.work') @HttpCode(200)
  rateVendor(@CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body() dto: RateVendorDto, @ClientIp() ip?: string) {
    return this.requests.rateVendor(u, id, dto.rating, ip);
  }

  // --- Jobs (on demand) -------------------------------------------------------------

  @Post('jobs/sla/run') @RequirePermission('concierge.settings') @HttpCode(200)
  runSla(@CurrentUser() u: AuthUser) {
    return this.requests.escalateTenant(u.tenantId).then((escalated) => ({ escalated }));
  }

  @Post('jobs/redaction/run') @RequirePermission('concierge.settings') @HttpCode(200)
  runRedaction(@CurrentUser() u: AuthUser) {
    return this.requests.redactTenant(u.tenantId).then((redacted) => ({ redacted }));
  }
}
