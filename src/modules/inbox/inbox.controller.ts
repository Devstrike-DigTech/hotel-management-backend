import { Body, Controller, Delete, Get, HttpCode, Param, ParseUUIDPipe, Patch, Post, Put, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { AuthUser } from '../../common/auth-types.js';
import { ClientIp, CurrentUser, RequirePermission } from '../../common/decorators/index.js';
import { AppException } from '../../common/errors/app-exception.js';
import { AppConfigService } from '../../config/app-config.service.js';
import { RequireFeature } from '../entitlements/entitlements.decorators.js';
import {
  AcceptSuggestionDto,
  ConversationsQueryDto,
  DetailQueryDto,
  DevInboundDto,
  InboxSettingsDto,
  NoteDto,
  PatchConversationDto,
  QuickReplyDto,
  ReplyDto,
  StartConversationDto,
  TemplateDto,
  UpdateQuickReplyDto,
} from './inbox.dto.js';
import { GuestInboxService } from './inbox.service.js';

@ApiTags('Guest inbox')
@ApiBearerAuth()
@RequireFeature('whatsapp_messaging')
@Controller('inbox')
export class InboxController {
  constructor(
    private readonly inbox: GuestInboxService,
    private readonly config: AppConfigService,
  ) {}

  @Get('summary') @RequirePermission('inbox.view')
  summary(@CurrentUser() u: AuthUser) { return this.inbox.summary(u); }

  @Get('conversations') @RequirePermission('inbox.view')
  list(@CurrentUser() u: AuthUser, @Query() q: ConversationsQueryDto) { return this.inbox.list(u, q); }

  @Post('conversations') @RequirePermission('inbox.reply')
  @ApiOperation({ summary: 'Start a conversation with an approved template' })
  start(@CurrentUser() u: AuthUser, @Body() dto: StartConversationDto) { return this.inbox.start(u, dto); }

  @Get('conversations/:id') @RequirePermission('inbox.view')
  get(@CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Query() q: DetailQueryDto) { return this.inbox.get(u, id, q.before); }

  @Patch('conversations/:id') @RequirePermission('inbox.reply')
  patch(@CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body() dto: PatchConversationDto, @ClientIp() ip?: string) { return this.inbox.patch(u, id, dto, ip); }

  @Post('conversations/:id/messages') @RequirePermission('inbox.reply')
  reply(@CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body() dto: ReplyDto) { return this.inbox.reply(u, id, dto); }

  @Post('conversations/:id/template') @RequirePermission('inbox.reply')
  template(@CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body() dto: TemplateDto) { return this.inbox.sendTemplate(u, id, dto); }

  @Post('conversations/:id/notes') @RequirePermission('inbox.reply')
  note(@CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body() dto: NoteDto) { return this.inbox.note(u, id, dto.body); }

  @Post('conversations/:id/read') @RequirePermission('inbox.view') @HttpCode(200)
  read(@CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string) { return this.inbox.markRead(u, id); }

  @Post('suggestions/:id/accept') @RequirePermission('inbox.reply') @HttpCode(200)
  accept(@CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body() dto: AcceptSuggestionDto, @ClientIp() ip?: string) { return this.inbox.acceptSuggestion(u, id, dto, ip); }

  @Post('suggestions/:id/dismiss') @RequirePermission('inbox.reply') @HttpCode(200)
  dismiss(@CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string) { return this.inbox.dismissSuggestion(u, id); }

  @Get('quick-replies') @RequirePermission('inbox.view')
  quickReplies(@CurrentUser() u: AuthUser) { return this.inbox.listQuickReplies(u); }

  @Post('quick-replies') @RequirePermission('inbox.manage')
  createQuickReply(@CurrentUser() u: AuthUser, @Body() dto: QuickReplyDto) { return this.inbox.createQuickReply(u, dto); }

  @Patch('quick-replies/:id') @RequirePermission('inbox.manage')
  updateQuickReply(@CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateQuickReplyDto) { return this.inbox.updateQuickReply(u, id, dto); }

  @Delete('quick-replies/:id') @RequirePermission('inbox.manage')
  removeQuickReply(@CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string) { return this.inbox.removeQuickReply(u, id); }

  @Get('settings') @RequirePermission('inbox.view')
  settings(@CurrentUser() u: AuthUser) { return this.inbox.getSettings(u); }

  @Put('settings') @RequirePermission('inbox.manage')
  putSettings(@CurrentUser() u: AuthUser, @Body() dto: InboxSettingsDto, @ClientIp() ip?: string) { return this.inbox.putSettings(u, dto, ip); }

  @Post('dev/inbound') @RequirePermission('inbox.reply') @HttpCode(200)
  @ApiOperation({ summary: 'Development only: a guest WhatsApp message through the real inbound pipeline' })
  devInbound(@Body() dto: DevInboundDto) {
    if (this.config.get('NODE_ENV') === 'production') throw AppException.notFound('Route');
    return this.inbox.devInbound(dto);
  }
}
