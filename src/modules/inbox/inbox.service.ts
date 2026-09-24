import { HttpStatus, Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import type { Conversation, ConversationMessage, InboxSetting, Prisma, Property, TaskSuggestion } from '../../generated/prisma/client.js';
import type { ConversationStatus, MessageDirection, TaskPriority } from '../../generated/prisma/enums.js';
import type { AuthUser } from '../../common/auth-types.js';
import { AppException } from '../../common/errors/app-exception.js';
import { can } from '../../common/permissions/can.js';
import { runInProperty } from '../../common/property-scope.js';
import { registerStayHooks } from '../../common/stay-hooks.js';
import { humanDate, lagosDate } from '../../common/time/lagos.js';
import { DbService, type Tx } from '../../prisma/db.service.js';
import { AuditService, userActor } from '../audit/audit.service.js';
import { EntitlementsService } from '../entitlements/entitlements.service.js';
import { GuestsService } from '../guests/guests.service.js';
import { HousekeepingService } from '../housekeeping/housekeeping.service.js';
import { LedgerService } from '../folios/ledger.service.js';
import { MaintenanceService } from '../maintenance/maintenance.service.js';
import { NotificationService } from '../notifications/notification.service.js';
import { appError, Err, isUniqueViolation, paginate, primaryProperty } from '../ops/ops.helpers.js';
import { ReservationsService } from '../reservations/reservations.service.js';
import { cleanParam, fillTemplate, type WhatsAppTemplateName } from '../whatsapp/templates.registry.js';
import { firstName, humanTime, isConfirmation, keywordHits, parseArrivalTime, phoneDigits, renderQuickReply, windowOf, type QuickReplyVars } from './inbox.logic.js';
import { inSeries } from '../../common/utils/in-series.js';

const FEATURE = 'whatsapp_messaging';
const PAGE_MESSAGES = 200;
const ROUTE_DAYS = 30;
const DAY = 24 * 3_600_000;
const INBOX_TEMPLATES: WhatsAppTemplateName[] = ['guest_message', 'pre_arrival_confirm', 'in_stay_welcome', 'booking_confirmed', 'pre_arrival', 'review_request', 'payment_receipt'];
const STATUS_RANK: Record<string, number> = { QUEUED: 0, OUTBOX: 1, SENT: 1, DELIVERED: 2, READ: 3, FAILED: 4 };

export interface GuestInbound {
  providerMessageId: string;
  from: string;
  text: string;
  name?: string | null;
  phoneNumberId?: string | null;
}

type Sender = { id: string; fullName: string } | null;

/**
 * M5 guest WhatsApp inbox (feature `whatsapp_messaging`): conversations per
 * property, the 24-hour window, templates, quick replies, assignment, SLA,
 * keyword task suggestions and the arrival-time flow.
 */
@Injectable()
export class GuestInboxService implements OnModuleInit {
  private readonly logger = new Logger(GuestInboxService.name);

  constructor(
    private readonly db: DbService,
    private readonly audit: AuditService,
    private readonly entitlements: EntitlementsService,
    private readonly notifications: NotificationService,
    private readonly refs: ModuleRef,
  ) {}

  onModuleInit() {
    registerStayHooks({
      name: 'inbox',
      afterCheckIn: (tenantId, id) => this.inStayWelcome(tenantId, id),
      afterPreArrival: (tenantId, id) => this.preArrivalConfirm(tenantId, id),
    });
  }

  private get reservations() {
    return this.refs.get(ReservationsService, { strict: false });
  }

  // ---------------------------------------------------------------------------
  // Settings and quick replies
  // ---------------------------------------------------------------------------

  async settingsRow(tx: Tx, tenantId: string, propertyId: string): Promise<InboxSetting> {
    const s = await tx.inboxSetting.findFirst({ where: { propertyId } });
    if (s) return s;
    return tx.inboxSetting.upsert({ where: { propertyId }, create: { tenantId, propertyId }, update: {} });
  }

  private settingsView(s: InboxSetting) {
    return {
      enabled: s.enabled,
      wifiName: s.wifiName,
      wifiPassword: s.wifiPassword,
      directions: s.directions,
      preArrivalConfirm: s.preArrivalConfirm,
      inStayPrompt: s.inStayPrompt,
      keywordSuggestions: s.keywordSuggestions,
      slaMinutes: s.slaMinutes,
      phoneNumberId: s.phoneNumberId,
      whatsappPhone: s.whatsappPhone,
    };
  }

  getSettings(user: AuthUser) {
    return this.db.tenant(user.tenantId, async (tx) => this.settingsView(await this.settingsRow(tx, user.tenantId, (await primaryProperty(tx, user.tenantId)).id)));
  }

  putSettings(user: AuthUser, dto: Partial<ReturnType<GuestInboxService['settingsView']>>, ip?: string) {
    return this.db.tenant(user.tenantId, async (tx) => {
      const p = await primaryProperty(tx, user.tenantId);
      const cur = await this.settingsRow(tx, user.tenantId, p.id);
      const data = Object.fromEntries(Object.entries(dto).filter(([, v]) => v !== undefined)) as Prisma.InboxSettingUpdateInput;
      let s: InboxSetting;
      try {
        s = await tx.inboxSetting.update({ where: { id: cur.id }, data });
      } catch (e) {
        if (isUniqueViolation(e)) throw Err.validation('phoneNumberId', 'That WhatsApp phone number id is already used by another property');
        throw e;
      }
      await this.audit.record(tx, { tenantId: user.tenantId, actor: userActor(user), action: 'inbox.settings_updated', entityType: 'inbox_setting', entityId: s.id, metadata: { ...dto, wifiPassword: dto.wifiPassword !== undefined ? '(changed)' : undefined }, ip });
      return this.settingsView(s);
    });
  }

  private quickReplyView(q: { id: string; title: string; shortcut: string; body: string; sortOrder: number }) {
    return { id: q.id, title: q.title, shortcut: q.shortcut, body: q.body, sortOrder: q.sortOrder };
  }

  listQuickReplies(user: AuthUser) {
    return this.db.tenant(user.tenantId, async (tx) => {
      const p = await primaryProperty(tx, user.tenantId);
      const rows = await tx.quickReply.findMany({ where: { propertyId: p.id }, orderBy: [{ sortOrder: 'asc' }, { title: 'asc' }] });
      return rows.map((q) => this.quickReplyView(q));
    });
  }

  createQuickReply(user: AuthUser, dto: { title: string; shortcut?: string; body: string; sortOrder?: number }) {
    return this.db.tenant(user.tenantId, async (tx) => {
      const p = await primaryProperty(tx, user.tenantId);
      const q = await tx.quickReply.create({ data: { tenantId: user.tenantId, propertyId: p.id, title: dto.title.trim(), shortcut: (dto.shortcut ?? '').trim(), body: dto.body, sortOrder: dto.sortOrder ?? 0 } });
      return this.quickReplyView(q);
    });
  }

  updateQuickReply(user: AuthUser, id: string, dto: { title?: string; shortcut?: string; body?: string; sortOrder?: number }) {
    return this.db.tenant(user.tenantId, async (tx) => {
      const q = await tx.quickReply.findFirst({ where: { id, tenantId: user.tenantId } });
      if (!q) throw AppException.notFound('Quick reply');
      const u = await tx.quickReply.update({
        where: { id },
        data: { ...(dto.title !== undefined && { title: dto.title.trim() }), ...(dto.shortcut !== undefined && { shortcut: dto.shortcut.trim() }), ...(dto.body !== undefined && { body: dto.body }), ...(dto.sortOrder !== undefined && { sortOrder: dto.sortOrder }) },
      });
      return this.quickReplyView(u);
    });
  }

  removeQuickReply(user: AuthUser, id: string) {
    return this.db.tenant(user.tenantId, async (tx) => {
      const q = await tx.quickReply.findFirst({ where: { id, tenantId: user.tenantId } });
      if (!q) throw AppException.notFound('Quick reply');
      await tx.quickReply.delete({ where: { id } });
      return { deleted: true };
    });
  }

  // ---------------------------------------------------------------------------
  // Views
  // ---------------------------------------------------------------------------

  private messageView(m: ConversationMessage) {
    return {
      id: m.id,
      direction: m.direction,
      body: m.body,
      template: m.templateName ? { name: m.templateName, params: m.templateParams } : null,
      status: m.status,
      error: m.error,
      sentBy: m.sentById ? { id: m.sentById, fullName: m.sentByName ?? '' } : null,
      createdAt: m.createdAt.toISOString(),
    };
  }

  private suggestionView(s: TaskSuggestion, rooms: Map<string, string>) {
    return {
      id: s.id,
      kind: s.kind as 'HOUSEKEEPING' | 'MAINTENANCE',
      keyword: s.keyword,
      summary: s.summary,
      category: s.category,
      room: s.roomId ? { id: s.roomId, number: rooms.get(s.roomId) ?? '' } : null,
      messageId: s.messageId,
      status: s.status,
      housekeepingTaskId: s.housekeepingTaskId,
      ticketId: s.ticketId,
      createdAt: s.createdAt.toISOString(),
    };
  }

  private async listItems(tx: Tx, rows: Conversation[], now = new Date()) {
    const guestIds = [...new Set(rows.map((c) => c.guestId).filter((x): x is string => !!x))];
    const resIds = [...new Set(rows.map((c) => c.reservationId).filter((x): x is string => !!x))];
    const [guests, members, stays, pending] = await inSeries(
      () => guestIds.length ? tx.guest.findMany({ where: { id: { in: guestIds } }, select: { id: true, vip: true } }) : [],
      () => guestIds.length ? tx.loyaltyMember.findMany({ where: { guestId: { in: guestIds } }, select: { guestId: true, tier: { select: { name: true } } } }) : [],
      () => resIds.length ? tx.reservation.findMany({ where: { id: { in: resIds } }, select: { id: true, code: true, status: true, arrivalAt: true, departureAt: true, room: { select: { number: true } } } }) : [],
      () => rows.length ? tx.taskSuggestion.groupBy({ by: ['conversationId'], where: { conversationId: { in: rows.map((c) => c.id) }, status: 'PENDING' }, _count: { _all: true } }) : [],
    );
    const vip = new Map(guests.map((g) => [g.id, g.vip]));
    const tier = new Map(members.map((m) => [m.guestId, m.tier?.name ?? null]));
    const res = new Map(stays.map((r) => [r.id, r]));
    const pend = new Map(pending.map((p) => [p.conversationId, p._count._all]));
    return rows.map((c) => {
      const r = c.reservationId ? res.get(c.reservationId) : undefined;
      return {
        id: c.id,
        propertyId: c.propertyId,
        status: c.status,
        guest: { id: c.guestId, fullName: c.guestName, phone: c.guestPhone, vip: c.guestId ? (vip.get(c.guestId) ?? false) : false, loyaltyTier: c.guestId ? (tier.get(c.guestId) ?? null) : null },
        reservation: r ? { id: r.id, code: r.code, status: r.status, roomNumber: r.room?.number ?? null, arrivalDate: lagosDate(r.arrivalAt), departureDate: lagosDate(r.departureAt) } : null,
        assignee: c.assigneeId ? { id: c.assigneeId, fullName: c.assigneeName ?? '' } : null,
        lastMessage: c.lastDirection ? { direction: c.lastDirection, body: c.lastPreview, at: c.lastMessageAt.toISOString() } : null,
        unreadCount: c.unreadCount,
        window: windowOf(c.lastInboundAt, now),
        overdue: !!c.slaDueAt && c.status !== 'CLOSED' && c.slaDueAt < now,
        slaDueAt: c.slaDueAt?.toISOString() ?? null,
        pendingSuggestions: pend.get(c.id) ?? 0,
        updatedAt: c.updatedAt.toISOString(),
      };
    });
  }

  private async detailTx(tx: Tx, tenantId: string, c: Conversation, before?: string) {
    const [item] = await this.listItems(tx, [c]);
    let beforeAt: Date | undefined;
    if (before) {
      const b = await tx.conversationMessage.findFirst({ where: { id: before, conversationId: c.id } });
      beforeAt = b?.createdAt;
    }
    const msgs = await tx.conversationMessage.findMany({
      where: { conversationId: c.id, ...(beforeAt && { createdAt: { lt: beforeAt } }) },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: PAGE_MESSAGES,
    });
    const suggestions = await tx.taskSuggestion.findMany({ where: { conversationId: c.id }, orderBy: { createdAt: 'desc' }, take: 50 });
    const rooms = new Map(
      (await tx.room.findMany({ where: { id: { in: suggestions.map((s) => s.roomId).filter((x): x is string => !!x) } }, select: { id: true, number: true } })).map((r) => [r.id, r.number]),
    );
    let guest = null;
    let stays: unknown[] = [];
    let loyalty = null;
    if (c.guestId) {
      const g = await tx.guest.findFirst({ where: { id: c.guestId } });
      if (g) {
        const guests = this.refs.get(GuestsService, { strict: false });
        const stats = await guests.stats(tx, [g.id]);
        guest = guests.toView(g, stats.get(g.id));
        stays = await this.reservations.guestStays(tx, tenantId, g.id, c.propertyId, 5);
      }
      const m = await tx.loyaltyMember.findFirst({ where: { guestId: c.guestId }, include: { tier: { select: { name: true } } } });
      if (m) loyalty = { memberNo: m.memberNo, tier: m.tier?.name ?? '', points: m.points };
    }
    let balanceKobo: number | null = null;
    if (c.reservationId) {
      const folio = await tx.folio.findFirst({ where: { reservationId: c.reservationId }, select: { id: true } });
      if (folio) balanceKobo = await this.refs.get(LedgerService, { strict: false }).balance(tx, folio.id);
    }
    return {
      ...item,
      messages: msgs.reverse().map((m) => this.messageView(m)),
      suggestions: suggestions.map((s) => this.suggestionView(s, rooms)),
      context: { guest, stays, balanceKobo, loyalty },
      notes: c.notes,
    };
  }

  private async load(tx: Tx, tenantId: string, id: string) {
    const c = await tx.conversation.findFirst({ where: { id, tenantId } });
    if (!c) throw AppException.notFound('Conversation');
    return c;
  }

  // ---------------------------------------------------------------------------
  // Queries
  // ---------------------------------------------------------------------------

  summary(user: AuthUser) {
    return this.db.tenant(user.tenantId, async (tx) => this.summaryTx(tx, (await primaryProperty(tx, user.tenantId)).id, user.userId));
  }

  async summaryTx(tx: Tx, propertyId: string, userId?: string) {
    const live = { propertyId, status: { not: 'CLOSED' as const } };
    const [unread, open, unassigned, overdue, mine, pendingSuggestions] = await inSeries(
      () => tx.conversation.count({ where: { ...live, unreadCount: { gt: 0 } } }),
      () => tx.conversation.count({ where: live }),
      () => tx.conversation.count({ where: { ...live, assigneeId: null } }),
      () => tx.conversation.count({ where: { ...live, slaDueAt: { lt: new Date() } } }),
      () => userId ? tx.conversation.count({ where: { ...live, assigneeId: userId } }) : 0,
      () => tx.taskSuggestion.count({ where: { propertyId, status: 'PENDING' } }),
    );
    return { unread, open, unassigned, overdue, mine, pendingSuggestions };
  }

  list(user: AuthUser, q: { status?: string; assigneeId?: string; mine?: boolean; unread?: boolean; q?: string; page?: number; pageSize?: number }) {
    const pg = paginate(q.page, q.pageSize);
    const statuses = (q.status ? q.status.split(',') : ['OPEN', 'PENDING']).filter((s): s is ConversationStatus => ['OPEN', 'PENDING', 'CLOSED'].includes(s));
    return this.db.tenant(user.tenantId, async (tx) => {
      const p = await primaryProperty(tx, user.tenantId);
      const text = q.q?.trim();
      const where: Prisma.ConversationWhereInput = {
        propertyId: p.id,
        status: { in: statuses.length ? statuses : ['OPEN', 'PENDING'] },
        ...(q.assigneeId && { assigneeId: q.assigneeId }),
        ...(q.mine && { assigneeId: user.userId }),
        ...(q.unread && { unreadCount: { gt: 0 } }),
        ...(text && { OR: [{ guestName: { contains: text, mode: 'insensitive' } }, { guestPhone: { contains: text.replace(/\s/g, '') } }, { lastPreview: { contains: text, mode: 'insensitive' } }] }),
      };
      const [rows, total] = await inSeries(
        () => tx.conversation.findMany({ where, orderBy: [{ lastMessageAt: 'desc' }, { id: 'asc' }], skip: pg.skip, take: pg.take }),
        () => tx.conversation.count({ where }),
      );
      return { items: await this.listItems(tx, rows), total, page: pg.page, pageSize: pg.pageSize };
    });
  }

  get(user: AuthUser, id: string, before?: string) {
    return this.db.tenant(user.tenantId, async (tx) => this.detailTx(tx, user.tenantId, await this.load(tx, user.tenantId, id), before));
  }

  // ---------------------------------------------------------------------------
  // Sending
  // ---------------------------------------------------------------------------

  /** Records an outgoing message, sends it (outside the transaction) and mirrors the delivery status. */
  private async sendOut(
    tenantId: string,
    conversationId: string,
    msg: { direction: MessageDirection; body: string; template?: { name: WhatsAppTemplateName; params: string[] } | null; sender: Sender; answers?: boolean },
  ) {
    const { row, conv } = await this.db.tenant(tenantId, async (tx) => {
      const c = await this.load(tx, tenantId, conversationId);
      const row = await tx.conversationMessage.create({
        data: {
          tenantId,
          propertyId: c.propertyId,
          conversationId: c.id,
          direction: msg.direction,
          body: msg.body,
          templateName: msg.template?.name ?? null,
          templateParams: msg.template?.params ?? [],
          status: 'QUEUED',
          sentById: msg.sender?.id ?? null,
          sentByName: msg.sender?.fullName ?? null,
        },
      });
      await tx.conversation.update({
        where: { id: c.id },
        data: {
          lastMessageAt: row.createdAt,
          lastOutboundAt: row.createdAt,
          lastPreview: msg.body.slice(0, 120),
          lastDirection: msg.direction,
          ...(msg.answers !== false && { slaDueAt: null, unreadCount: 0 }),
          ...(msg.sender && c.status === 'OPEN' && { status: 'PENDING' }),
        },
      });
      return { row, conv: c };
    });
    const res = await this.notifications.sendNow({
      tenantId,
      reservationId: conv.reservationId,
      template: 'WHATSAPP_REPLY',
      channel: 'WHATSAPP',
      audience: 'GUEST',
      to: conv.guestPhone,
      subject: null,
      text: msg.body,
      html: null,
      waTemplate: msg.template ? { name: msg.template.name, language: 'en', params: msg.template.params } : null,
      meta: { conversationId, messageId: row.id },
    });
    const status = res.ok ? (res.outbox ? 'OUTBOX' : 'SENT') : 'FAILED';
    return this.db.tenant(tenantId, (tx) =>
      tx.conversationMessage.update({ where: { id: row.id }, data: { status, providerMessageId: res.providerMessageId, error: res.error } }),
    );
  }

  private async quickReplyVars(tx: Tx, c: Conversation): Promise<QuickReplyVars> {
    const p = await tx.property.findFirstOrThrow({ where: { id: c.propertyId } });
    const s = await this.settingsRow(tx, c.tenantId, c.propertyId);
    const r = c.reservationId ? await tx.reservation.findFirst({ where: { id: c.reservationId }, select: { code: true, room: { select: { number: true } } } }) : null;
    return {
      guest_first_name: firstName(c.guestName),
      hotel_name: p.name,
      wifi_name: s.wifiName,
      wifi_password: s.wifiPassword,
      check_out_time: p.checkOutTime,
      check_in_time: p.checkInTime,
      directions: s.directions,
      hotel_phone: p.phone,
      reservation_code: r?.code ?? '',
      room_number: r?.room?.number ?? '',
    };
  }

  async reply(user: AuthUser, id: string, dto: { body?: string; quickReplyId?: string }) {
    const body = await this.db.tenant(user.tenantId, async (tx) => {
      const c = await this.load(tx, user.tenantId, id);
      const w = windowOf(c.lastInboundAt);
      if (!w.open) {
        throw appError(HttpStatus.CONFLICT, 'WHATSAPP_WINDOW_CLOSED', 'The guest has not written in the last 24 hours; send an approved template instead', {
          lastInboundAt: c.lastInboundAt?.toISOString() ?? null,
          windowClosedAt: w.expiresAt,
        });
      }
      if (dto.quickReplyId) {
        const q = await tx.quickReply.findFirst({ where: { id: dto.quickReplyId, propertyId: c.propertyId } });
        if (!q) throw AppException.notFound('Quick reply');
        return renderQuickReply(q.body, await this.quickReplyVars(tx, c));
      }
      const text = dto.body?.trim();
      if (!text) throw Err.validation('body', 'Write a message or pick a quick reply');
      return text;
    });
    const m = await this.sendOut(user.tenantId, id, { direction: 'OUTBOUND', body, sender: { id: user.userId, fullName: user.fullName } });
    return this.messageView(m);
  }

  private templateBody(name: WhatsAppTemplateName, params: string[]) {
    if (!INBOX_TEMPLATES.includes(name)) throw Err.validation('name', 'That template cannot be sent from the inbox');
    const clean = params.map(cleanParam);
    return { template: { name, params: clean }, body: fillTemplate(name, clean) };
  }

  async sendTemplate(user: AuthUser, id: string, dto: { name: WhatsAppTemplateName; params: string[] }) {
    const t = this.templateBody(dto.name, dto.params);
    await this.db.tenant(user.tenantId, (tx) => this.load(tx, user.tenantId, id));
    const m = await this.sendOut(user.tenantId, id, { direction: 'OUTBOUND', body: t.body, template: t.template, sender: { id: user.userId, fullName: user.fullName } });
    return this.messageView(m);
  }

  note(user: AuthUser, id: string, body: string) {
    return this.db.tenant(user.tenantId, async (tx) => {
      const c = await this.load(tx, user.tenantId, id);
      const m = await tx.conversationMessage.create({
        data: { tenantId: user.tenantId, propertyId: c.propertyId, conversationId: c.id, direction: 'NOTE', body: body.trim(), status: 'SENT', sentById: user.userId, sentByName: user.fullName },
      });
      return this.messageView(m);
    });
  }

  markRead(user: AuthUser, id: string) {
    return this.db.tenant(user.tenantId, async (tx) => {
      const c = await this.load(tx, user.tenantId, id);
      await tx.conversation.update({ where: { id: c.id }, data: { unreadCount: 0 } });
      return { success: true };
    });
  }

  patch(user: AuthUser, id: string, dto: { status?: ConversationStatus; assigneeId?: string | null; reservationId?: string | null; notes?: string }, ip?: string) {
    return this.db.tenant(user.tenantId, async (tx) => {
      const c = await this.load(tx, user.tenantId, id);
      const data: Prisma.ConversationUpdateInput = {};
      if (dto.assigneeId !== undefined) {
        const self = dto.assigneeId === user.userId || (dto.assigneeId === null && c.assigneeId === user.userId);
        if (!self && !can(user, 'inbox.manage')) throw AppException.forbidden('Only an inbox manager can assign conversations to others');
        if (dto.assigneeId) {
          const u = await tx.user.findFirst({ where: { id: dto.assigneeId, tenantId: user.tenantId, isActive: true }, select: { id: true, fullName: true } });
          if (!u) throw Err.validation('assigneeId', 'Unknown or inactive staff member');
          Object.assign(data, { assigneeId: u.id, assigneeName: u.fullName });
        } else Object.assign(data, { assigneeId: null, assigneeName: null });
      }
      if (dto.reservationId !== undefined) {
        if (dto.reservationId) {
          const r = await tx.reservation.findFirst({ where: { id: dto.reservationId, propertyId: c.propertyId, ...(c.guestId && { guestId: c.guestId }) } });
          if (!r) throw AppException.notFound('Reservation');
        }
        data.reservationId = dto.reservationId;
      }
      if (dto.notes !== undefined) data.notes = dto.notes;
      if (dto.status && dto.status !== c.status) {
        if (dto.status !== 'CLOSED' && c.status === 'CLOSED') {
          const other = await tx.conversation.findFirst({ where: { propertyId: c.propertyId, guestPhone: c.guestPhone, status: { not: 'CLOSED' }, id: { not: c.id } } });
          if (other) throw Err.invalidState('CLOSED', ['OPEN', 'PENDING'], 'Another conversation with this guest is open, so this one');
        }
        data.status = dto.status;
        if (dto.status === 'CLOSED') Object.assign(data, { slaDueAt: null, unreadCount: 0, flowState: null });
      }
      const u = await tx.conversation.update({ where: { id: c.id }, data });
      await this.audit.record(tx, { tenantId: user.tenantId, actor: userActor(user), action: 'inbox.conversation_updated', entityType: 'conversation', entityId: c.id, metadata: { ...dto }, ip });
      return (await this.listItems(tx, [u]))[0];
    });
  }

  /** Staff start a conversation (always an approved template). */
  async start(user: AuthUser, dto: { guestId?: string; phone?: string; reservationId?: string; template: { name: WhatsAppTemplateName; params: string[] } }) {
    const t = this.templateBody(dto.template.name, dto.template.params);
    const conversationId = await this.db.tenant(user.tenantId, async (tx) => {
      const p = await primaryProperty(tx, user.tenantId);
      let guest = dto.guestId ? await tx.guest.findFirst({ where: { id: dto.guestId, tenantId: user.tenantId } }) : null;
      if (dto.guestId && !guest) throw AppException.notFound('Guest');
      let reservationId: string | null = null;
      if (dto.reservationId) {
        const r = await tx.reservation.findFirst({ where: { id: dto.reservationId, propertyId: p.id }, include: { guest: true } });
        if (!r) throw AppException.notFound('Reservation');
        reservationId = r.id;
        guest ??= r.guest;
      }
      const raw = guest?.phone ?? dto.phone;
      if (!raw || phoneDigits(raw).length < 10) throw Err.validation('phone', 'The guest has no WhatsApp number; add a phone number first');
      const phone = `+${phoneDigits(raw)}`;
      const c = await this.openConversation(tx, user.tenantId, p.id, { phone, guestId: guest?.id ?? null, guestName: guest?.fullName ?? phone, reservationId });
      return c.id;
    });
    await this.sendOut(user.tenantId, conversationId, { direction: 'OUTBOUND', body: t.body, template: t.template, sender: { id: user.userId, fullName: user.fullName } });
    return this.db.tenant(user.tenantId, async (tx) => this.detailTx(tx, user.tenantId, await this.load(tx, user.tenantId, conversationId)));
  }

  /** The open conversation for a phone in a property, or a new one. */
  private async openConversation(tx: Tx, tenantId: string, propertyId: string, g: { phone: string; guestId: string | null; guestName: string; reservationId: string | null }) {
    const existing = await tx.conversation.findFirst({ where: { propertyId, guestPhone: g.phone, status: { not: 'CLOSED' } } });
    if (existing) {
      if ((!existing.reservationId && g.reservationId) || (!existing.guestId && g.guestId)) {
        return tx.conversation.update({ where: { id: existing.id }, data: { reservationId: existing.reservationId ?? g.reservationId, guestId: existing.guestId ?? g.guestId, guestName: g.guestId ? g.guestName : existing.guestName } });
      }
      return existing;
    }
    return tx.conversation.create({ data: { tenantId, propertyId, guestPhone: g.phone, guestId: g.guestId, guestName: g.guestName, reservationId: g.reservationId, status: 'OPEN' } });
  }

  // ---------------------------------------------------------------------------
  // Suggestions
  // ---------------------------------------------------------------------------

  async acceptSuggestion(user: AuthUser, id: string, dto: { roomId?: string; priority?: TaskPriority; note?: string }, ip?: string) {
    const out = await this.db.tenant(user.tenantId, async (tx) => {
      const s = await tx.taskSuggestion.findFirst({ where: { id, tenantId: user.tenantId } });
      if (!s) throw AppException.notFound('Suggestion');
      if (s.status !== 'PENDING') throw Err.invalidState(s.status, ['PENDING'], 'This suggestion');
      const ent = await this.entitlements.getEntitlements(user.tenantId, tx);
      const msg = await tx.conversationMessage.findFirst({ where: { id: s.messageId } });
      const roomId = dto.roomId ?? s.roomId;
      if (!roomId) throw Err.validation('roomId', 'Pick the room');
      const room = await tx.room.findFirst({ where: { id: roomId, propertyId: s.propertyId } });
      if (!room) throw AppException.notFound('Room');
      const detail = [dto.note?.trim(), msg ? `Guest wrote: "${msg.body.slice(0, 300)}"` : null].filter(Boolean).join('\n');
      let housekeepingTaskId: string | null = null;
      let ticketId: string | null = null;
      if (s.kind === 'HOUSEKEEPING') {
        await this.entitlements.assertFeature(ent, 'housekeeping');
        const t = await this.refs.get(HousekeepingService, { strict: false }).createTask(tx, user.tenantId, ent.features, { roomId: room.id, reason: 'MANUAL', type: 'CUSTOM', priority: dto.priority ?? 'HIGH', notes: `${s.summary}. ${detail}`.trim() });
        if (!t) throw Err.invalidState('UNAVAILABLE', ['PENDING'], 'The housekeeping task');
        housekeepingTaskId = t.id;
      } else {
        await this.entitlements.assertFeature(ent, 'maintenance');
        const t = await this.refs.get(MaintenanceService, { strict: false }).createTx(
          tx,
          user.tenantId,
          { roomId: room.id, category: s.category ?? 'OTHER', priority: dto.priority ?? 'HIGH', title: `${s.summary}, room ${room.number}`, description: detail },
          { id: user.userId, name: user.fullName },
        );
        ticketId = t.id;
      }
      const u = await tx.taskSuggestion.update({ where: { id }, data: { status: 'CREATED', housekeepingTaskId, ticketId, decidedById: user.userId } });
      await this.audit.record(tx, { tenantId: user.tenantId, actor: userActor(user), action: 'inbox.suggestion_accepted', entityType: 'task_suggestion', entityId: id, metadata: { kind: s.kind, room: room.number, housekeepingTaskId, ticketId }, ip });
      const conv = await tx.conversation.findFirstOrThrow({ where: { id: s.conversationId } });
      return { suggestion: this.suggestionView(u, new Map([[room.id, room.number]])), housekeepingTaskId, ticketId, windowOpen: windowOf(conv.lastInboundAt).open, conversationId: conv.id };
    });
    if (out.windowOpen) {
      await this.sendOut(user.tenantId, out.conversationId, { direction: 'OUTBOUND', body: 'Thank you, we are on it.', sender: { id: user.userId, fullName: user.fullName } }).catch((e: Error) =>
        this.logger.warn(`Acknowledgement not sent: ${e.message}`),
      );
    }
    return { suggestion: out.suggestion, housekeepingTaskId: out.housekeepingTaskId, ticketId: out.ticketId };
  }

  dismissSuggestion(user: AuthUser, id: string) {
    return this.db.tenant(user.tenantId, async (tx) => {
      const s = await tx.taskSuggestion.findFirst({ where: { id, tenantId: user.tenantId } });
      if (!s) throw AppException.notFound('Suggestion');
      if (s.status !== 'PENDING') throw Err.invalidState(s.status, ['PENDING'], 'This suggestion');
      const u = await tx.taskSuggestion.update({ where: { id }, data: { status: 'DISMISSED', decidedById: user.userId } });
      const room = u.roomId ? await tx.room.findFirst({ where: { id: u.roomId }, select: { id: true, number: true } }) : null;
      const rooms = new Map(room ? [[room.id, room.number]] : []);
      return this.suggestionView(u, rooms);
    });
  }

  // ---------------------------------------------------------------------------
  // Inbound pipeline
  // ---------------------------------------------------------------------------

  /**
   * Routes a guest's WhatsApp message to a property: the business number's
   * property when known, else the guest's most relevant stay among hotels
   * with the inbox. Returns null when no hotel knows the sender.
   */
  private async route(digits: string, phoneNumberId: string | null | undefined, now: Date): Promise<{ tenantId: string; propertyId: string; guestId: string | null; guestName: string | null; reservationId: string | null } | null> {
    const local = digits.startsWith('234') ? `0${digits.slice(3)}` : digits;
    // M6: guests and inbox numbers of every database (shared and dedicated tenants).
    const guests = (await this.db.systemAll((tx, t) =>
      tx.$queryRaw<{ id: string; tenant_id: string; full_name: string }[]>`
        SELECT g.id, g.tenant_id, g.full_name FROM guests g
         WHERE g.anonymised_at IS NULL AND g.phone IS NOT NULL AND regexp_replace(g.phone, '[^0-9]', '', 'g') IN (${digits}, ${local})
           AND g.tenant_id <> ALL(${t.excludeTenantIds}::uuid[])`,
    )).flat();
    const pinned = phoneNumberId ? ((await this.db.locate((tx, t) => tx.inboxSetting.findFirst({ where: { ...t.tenants, phoneNumberId }, select: { tenantId: true, propertyId: true } })))?.value ?? null) : null;
    type Cand = { tenantId: string; propertyId: string; guestId: string; guestName: string; reservationId: string; rank: number; at: number };
    const cands: Cand[] = [];
    for (const g of guests) {
      if (pinned && pinned.tenantId !== g.tenant_id) continue;
      const ent = await this.entitlements.getEntitlements(g.tenant_id).catch(() => null);
      if (!ent?.features.includes(FEATURE)) continue;
      const stays = await this.db.systemFor(g.tenant_id, (tx) =>
        tx.reservation.findMany({
          where: {
            tenantId: g.tenant_id,
            guestId: g.id,
            ...(pinned && { propertyId: pinned.propertyId }),
            OR: [
              { status: 'CHECKED_IN' },
              { status: { in: ['PENDING', 'CONFIRMED'] }, arrivalAt: { lte: new Date(now.getTime() + ROUTE_DAYS * DAY) }, departureAt: { gt: now } },
              { status: 'CHECKED_OUT', departureAt: { gte: new Date(now.getTime() - ROUTE_DAYS * DAY) } },
            ],
          },
          select: { id: true, propertyId: true, status: true, arrivalAt: true, departureAt: true },
        }),
      );
      for (const r of stays) {
        const rank = r.status === 'CHECKED_IN' ? 0 : r.status === 'CHECKED_OUT' ? 2 : 1;
        const at = rank === 1 ? r.arrivalAt.getTime() : -r.departureAt.getTime();
        cands.push({ tenantId: g.tenant_id, propertyId: r.propertyId, guestId: g.id, guestName: g.full_name, reservationId: r.id, rank, at });
      }
    }
    cands.sort((a, b) => a.rank - b.rank || a.at - b.at);
    const best = cands[0];
    if (best) return best;
    if (pinned) {
      const ent = await this.entitlements.getEntitlements(pinned.tenantId).catch(() => null);
      if (!ent?.features.includes(FEATURE)) return null;
      const g = guests.find((x) => x.tenant_id === pinned.tenantId);
      return { tenantId: pinned.tenantId, propertyId: pinned.propertyId, guestId: g?.id ?? null, guestName: g?.full_name ?? null, reservationId: null };
    }
    // A known guest with no current stay: the conversation they already have, if any.
    for (const g of guests) {
      const ent = await this.entitlements.getEntitlements(g.tenant_id).catch(() => null);
      if (!ent?.features.includes(FEATURE)) continue;
      const open = await this.db.systemFor(g.tenant_id, (tx) => tx.conversation.findFirst({ where: { tenantId: g.tenant_id, guestId: g.id, status: { not: 'CLOSED' } }, orderBy: { lastMessageAt: 'desc' } }));
      if (open) return { tenantId: g.tenant_id, propertyId: open.propertyId, guestId: g.id, guestName: g.full_name, reservationId: open.reservationId };
    }
    return null;
  }

  /** The guest-message pipeline (webhook and the dev simulator). */
  async receiveGuest(m: GuestInbound, now = new Date()): Promise<{ conversationId: string | null; routed: boolean; tenantId: string | null }> {
    const digits = phoneDigits(m.from);
    const phone = `+${digits}`;
    const target = await this.route(digits, m.phoneNumberId, now);
    if (!target) return { conversationId: null, routed: false, tenantId: null };
    const result = await this.db.tenant(target.tenantId, (tx) =>
      runInProperty(target.tenantId, target.propertyId, async () => {
        const s = await this.settingsRow(tx, target.tenantId, target.propertyId);
        if (!s.enabled) return null;
        const c = await this.openConversation(tx, target.tenantId, target.propertyId, { phone, guestId: target.guestId, guestName: target.guestName ?? m.name?.trim() ?? phone, reservationId: target.reservationId });
        let msg: ConversationMessage;
        try {
          msg = await tx.conversationMessage.create({
            data: { tenantId: target.tenantId, propertyId: target.propertyId, conversationId: c.id, direction: 'INBOUND', body: m.text.slice(0, 4096), status: 'RECEIVED', providerMessageId: m.providerMessageId, createdAt: now },
          });
        } catch (e) {
          if (isUniqueViolation(e)) return { conversationId: c.id, replies: [] as string[], duplicate: true };
          throw e;
        }
        await tx.conversation.update({
          where: { id: c.id },
          data: {
            lastMessageAt: now,
            lastInboundAt: now,
            lastPreview: m.text.slice(0, 120),
            lastDirection: 'INBOUND',
            unreadCount: { increment: 1 },
            status: 'OPEN',
            slaDueAt: c.slaDueAt ?? new Date(now.getTime() + s.slaMinutes * 60_000),
          },
        });
        const replies = await this.automations(tx, { ...c, lastInboundAt: now }, msg, s);
        return { conversationId: c.id, replies, duplicate: false };
      }),
    );
    if (!result) return { conversationId: null, routed: false, tenantId: target.tenantId };
    for (const body of result.replies) {
      await this.sendOut(target.tenantId, result.conversationId, { direction: 'SYSTEM', body, sender: null, answers: true }).catch((e: Error) => this.logger.warn(`Automatic reply not sent: ${e.message}`));
    }
    return { conversationId: result.conversationId, routed: true, tenantId: target.tenantId };
  }

  /** Arrival-time flow and keyword suggestions. Returns automatic replies to send. */
  private async automations(tx: Tx, c: Conversation, msg: ConversationMessage, s: InboxSetting): Promise<string[]> {
    const replies: string[] = [];
    const r = c.reservationId ? await tx.reservation.findFirst({ where: { id: c.reservationId }, select: { id: true, status: true, roomId: true } }) : null;
    if (c.flowState === 'ARRIVAL_CONFIRM' || c.flowState === 'ARRIVAL_TIME') {
      const time = parseArrivalTime(msg.body);
      if (time && r) {
        await tx.reservation.update({ where: { id: r.id }, data: { expectedArrivalTime: time } });
        await tx.conversation.update({ where: { id: c.id }, data: { flowState: null } });
        replies.push(`Thank you. We have noted your arrival at about ${humanTime(time)}. See you soon.`);
      } else if (c.flowState === 'ARRIVAL_CONFIRM' && isConfirmation(msg.body)) {
        await tx.conversation.update({ where: { id: c.id }, data: { flowState: 'ARRIVAL_TIME' } });
        replies.push('Thank you for confirming. What time do you expect to arrive?');
      }
    }
    if (s.keywordSuggestions && r?.status === 'CHECKED_IN') {
      for (const hit of keywordHits(msg.body)) {
        await tx.taskSuggestion.create({
          data: { tenantId: c.tenantId, propertyId: c.propertyId, conversationId: c.id, messageId: msg.id, kind: hit.kind, keyword: hit.keyword, summary: hit.summary, category: hit.category, roomId: r.roomId },
        });
      }
    }
    return replies;
  }

  /** WhatsApp delivery statuses (sent, delivered, read, failed) for inbox messages. */
  async applyStatus(providerMessageId: string, status: string, error?: string | null) {
    const next = status.toUpperCase();
    if (!(next in STATUS_RANK)) return false;
    const hit = await this.db.locate((tx, t) => tx.conversationMessage.findFirst({ where: { ...t.tenants, providerMessageId }, select: { tenantId: true } }));
    if (!hit) return false;
    return this.db.systemFor(hit.value.tenantId, async (tx) => {
      const m = await tx.conversationMessage.findUnique({ where: { providerMessageId }, select: { id: true, status: true } });
      if (!m) return false;
      if (next !== 'FAILED' && (STATUS_RANK[m.status] ?? 0) >= STATUS_RANK[next]) return false;
      await tx.conversationMessage.update({ where: { id: m.id }, data: { status: next, ...(error && { error: error.slice(0, 500) }) } });
      return true;
    });
  }

  /** Development simulator: the exact inbound pipeline, as if the webhook received it. */
  async devInbound(dto: { phone: string; body: string; name?: string }) {
    const id = `dev-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
    const digits = phoneDigits(dto.phone);
    await this.db.system((tx) => tx.whatsAppInbound.create({ data: { messageId: id, fromPhone: `+${digits}`, body: dto.body.slice(0, 1000) } }));
    const r = await this.receiveGuest({ providerMessageId: id, from: digits, text: dto.body, name: dto.name ?? null });
    await this.db.system((tx) => tx.whatsAppInbound.update({ where: { messageId: id }, data: { tenantId: r.tenantId, result: r.routed ? 'guest inbox' : 'unknown sender', handledAt: new Date() } }));
    return { conversationId: r.conversationId, routed: r.routed };
  }

  // ---------------------------------------------------------------------------
  // Automations
  // ---------------------------------------------------------------------------

  private async automationTarget(tenantId: string, reservationId: string, flag: 'preArrivalConfirm' | 'inStayPrompt') {
    const ent = await this.entitlements.getEntitlements(tenantId).catch(() => null);
    if (!ent?.features.includes(FEATURE)) return null;
    return this.db.tenant(tenantId, async (tx) => {
      const r = await tx.reservation.findFirst({ where: { id: reservationId, tenantId }, include: { guest: true, room: true, property: true } });
      if (!r?.guest.phone || phoneDigits(r.guest.phone).length < 10) return null;
      return runInProperty(tenantId, r.propertyId, async () => {
        const s = await this.settingsRow(tx, tenantId, r.propertyId);
        if (!s.enabled || !s[flag]) return null;
        const c = await this.openConversation(tx, tenantId, r.propertyId, { phone: `+${phoneDigits(r.guest.phone!)}`, guestId: r.guestId, guestName: r.guest.fullName, reservationId: r.id });
        if (c.reservationId !== r.id) await tx.conversation.update({ where: { id: c.id }, data: { reservationId: r.id } });
        return { c, r, property: r.property as Property };
      });
    });
  }

  async preArrivalConfirm(tenantId: string, reservationId: string) {
    const t = await this.automationTarget(tenantId, reservationId, 'preArrivalConfirm');
    if (!t) return;
    const tpl = this.templateBody('pre_arrival_confirm', [firstName(t.r.guest.fullName), t.property.name, humanDate(lagosDate(t.r.arrivalAt))]);
    await this.db.tenant(tenantId, (tx) => tx.conversation.update({ where: { id: t.c.id }, data: { flowState: 'ARRIVAL_CONFIRM' } }));
    await this.sendOut(tenantId, t.c.id, { direction: 'SYSTEM', body: tpl.body, template: tpl.template, sender: null, answers: false });
  }

  async inStayWelcome(tenantId: string, reservationId: string) {
    const t = await this.automationTarget(tenantId, reservationId, 'inStayPrompt');
    if (!t) return;
    const tpl = this.templateBody('in_stay_welcome', [t.property.name, firstName(t.r.guest.fullName), t.r.room?.number ?? '-']);
    await this.db.tenant(tenantId, (tx) => tx.conversation.update({ where: { id: t.c.id }, data: { flowState: null } }));
    await this.sendOut(tenantId, t.c.id, { direction: 'SYSTEM', body: tpl.body, template: tpl.template, sender: null, answers: false });
  }
}
