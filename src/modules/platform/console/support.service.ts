import { HttpStatus, Inject, Injectable, Logger } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { Prisma, SupportMessage, SupportRequest } from '../../../generated/prisma/client.js';
import type { AppRequest, AuthUser, PlatformPrincipal } from '../../../common/auth-types.js';
import { AppException } from '../../../common/errors/app-exception.js';
import { signToken, verifyToken } from '../../../common/crypto/signed-token.js';
import { currentPropertyId } from '../../../common/property-scope.js';
import { AppConfigService } from '../../../config/app-config.service.js';
import { DbService, type Tx } from '../../../prisma/db.service.js';
import { sniff, type UploadedFileLike } from '../../guests/guests.service.js';
import { NotificationService } from '../../notifications/notification.service.js';
import { renderTemplate } from '../../notifications/templates/templates.js';
import { appError, Err } from '../../ops/ops.helpers.js';
import { OBJECT_STORAGE, type ObjectStorage } from '../../storage/object-storage.js';
import { PlatformAuditService } from '../security/platform-audit.service.js';

export const SUPPORT_CATEGORIES = ['BILLING', 'TECHNICAL', 'ACCOUNT', 'BOOKINGS', 'PAYMENTS', 'FEATURE_REQUEST', 'DATA_PRIVACY', 'OTHER'] as const;
export const SUPPORT_PRIORITIES = ['LOW', 'NORMAL', 'HIGH', 'URGENT'] as const;
export const SUPPORT_STATUSES = ['NEW', 'OPEN', 'WAITING_ON_HOTEL', 'RESOLVED', 'CLOSED'] as const;
export type SupportStatus = (typeof SUPPORT_STATUSES)[number];

/** First-response SLA by plan (hours). */
export const SLA_HOURS: Record<string, number> = { starter: 48, growth: 24, pro: 8, enterprise: 2 };
export const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;
const ATTACHMENT_TYPES: Record<string, string> = {
  'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'application/pdf': 'pdf', 'text/plain': 'txt', 'text/csv': 'csv',
};
const OPEN_STATUSES: SupportStatus[] = ['NEW', 'OPEN', 'WAITING_ON_HOTEL'];
const RESOLVED_STATUSES: SupportStatus[] = ['RESOLVED', 'CLOSED'];

/** Status filter: a list of statuses (`status=OPEN,WAITING`) and/or `state=open|resolved|all`. */
export function statusFilter(status: string[] | undefined, state: string | undefined, fallback: SupportStatus[] | null): Prisma.SupportRequestWhereInput {
  const byState = state === 'open' ? OPEN_STATUSES : state === 'resolved' ? RESOLVED_STATUSES : null;
  let list: string[] | null = status?.length ? status : null;
  if (list && byState) list = list.filter((s) => (byState as string[]).includes(s));
  const chosen = list ?? byState ?? (state === 'all' ? null : fallback);
  return chosen ? { status: { in: chosen } } : {};
}

export type SlaState = 'ON_TRACK' | 'DUE_SOON' | 'BREACHED' | 'MET' | 'MISSED';

/** SLA state of a request at `now`: DUE_SOON in the last quarter of the window. */
export function slaState(r: { createdAt: Date; firstResponseDue: Date; firstRespondedAt: Date | null }, now = new Date()): SlaState {
  if (r.firstRespondedAt) return r.firstRespondedAt <= r.firstResponseDue ? 'MET' : 'MISSED';
  if (now > r.firstResponseDue) return 'BREACHED';
  const window = r.firstResponseDue.getTime() - r.createdAt.getTime();
  return r.firstResponseDue.getTime() - now.getTime() <= window / 4 ? 'DUE_SOON' : 'ON_TRACK';
}

export function supportNumber(seq: number): string {
  return `SR-${String(seq).padStart(6, '0')}`;
}

interface StoredAttachment {
  key: string;
  name: string;
  size: number;
  contentType: string;
}

/**
 * Support desk (M6). Requests and messages are control-plane rows (shared
 * database): hotels read their own through a signed tenant context, the
 * console through the platform connection. SLA by plan; internal notes never
 * reach hotels; replies email the requester.
 */
@Injectable()
export class SupportService {
  private readonly logger = new Logger(SupportService.name);

  constructor(
    private readonly db: DbService,
    private readonly config: AppConfigService,
    private readonly notifications: NotificationService,
    private readonly audit: PlatformAuditService,
    @Inject(OBJECT_STORAGE) private readonly storage: ObjectStorage,
  ) {}

  // ---------------------------------------------------------------------------
  // Attachments
  // ---------------------------------------------------------------------------

  attachmentUrl(key: string): string {
    const token = signToken(this.config.get('SHARE_TOKEN_SECRET'), 'support-file', { k: key, exp: Math.floor(Date.now() / 1000) + 600 });
    return `${this.config.get('API_PUBLIC_URL').replace(/\/$/, '')}/api/v1/public/support-files/${token}`;
  }

  async readAttachment(token: string) {
    const res = verifyToken<{ k: string; exp: number }>(this.config.get('SHARE_TOKEN_SECRET'), 'support-file', token);
    if (!res.ok) {
      if (res.reason === 'expired') throw appError(HttpStatus.GONE, 'LINK_EXPIRED', 'This link has expired');
      throw AppException.notFound('File');
    }
    const meta = await this.db.system((tx) => tx.supportAttachment.findUnique({ where: { key: res.payload.k } }));
    const obj = await this.storage.get(res.payload.k);
    if (!obj || !meta) throw AppException.notFound('File');
    return { body: obj.body, contentType: meta.contentType, name: meta.name };
  }

  private view(a: StoredAttachment) {
    return { ...a, url: this.attachmentUrl(a.key) };
  }

  async upload(by: { kind: 'HOTEL' | 'PLATFORM'; id: string; tenantId: string | null }, file: (UploadedFileLike & { originalname?: string }) | undefined) {
    if (!file) throw Err.validation('file', 'Attach the file as form field "file"');
    const ext = ATTACHMENT_TYPES[file.mimetype];
    if (!ext) throw Err.validation('file', 'Attach an image (PNG, JPEG, WebP), a PDF, a text or a CSV file');
    if (file.size > MAX_ATTACHMENT_BYTES) throw Err.validation('file', 'Attachments can be at most 10 MB');
    if (ext !== 'txt' && ext !== 'csv' && !sniff(file.buffer, file.mimetype)) throw Err.validation('file', 'The file content does not match its type');
    const key = by.tenantId ? `tenants/${by.tenantId}/support/${randomUUID()}.${ext}` : `platform/support/${randomUUID()}.${ext}`;
    await this.storage.put(key, file.buffer, file.mimetype);
    const name = (file.originalname ?? `attachment.${ext}`).replace(/[^\w .()-]/g, '_').slice(0, 120);
    await this.db.system((tx) => tx.supportAttachment.create({ data: { key, tenantId: by.tenantId, uploadedByKind: by.kind, uploadedById: by.id, name, size: file.size, contentType: file.mimetype } }));
    return this.view({ key, name, size: file.size, contentType: file.mimetype });
  }

  /** Claims uploaded, unattached files of this uploader for a new message. */
  private async claim(tx: Tx, keys: string[] | undefined, by: { kind: 'HOTEL' | 'PLATFORM'; id: string }, messageId: string): Promise<StoredAttachment[]> {
    if (!keys?.length) return [];
    const rows = await tx.supportAttachment.findMany({ where: { key: { in: keys }, uploadedByKind: by.kind, uploadedById: by.id, messageId: null } });
    if (rows.length !== new Set(keys).size) throw Err.validation('attachmentKeys', 'Upload each attachment first (and use it once)');
    await tx.supportAttachment.updateMany({ where: { key: { in: keys } }, data: { messageId } });
    return rows.map((r) => ({ key: r.key, name: r.name, size: r.size, contentType: r.contentType }));
  }

  // ---------------------------------------------------------------------------
  // Views
  // ---------------------------------------------------------------------------

  requestView(r: SupportRequest & { _count?: { messages: number } }, audience: 'HOTEL' | 'PLATFORM', tenant: { id: string; name: string; slug: string }, messageCount?: number) {
    const unread =
      audience === 'HOTEL'
        ? !!r.lastPlatformMsgAt && (!r.hotelReadAt || r.lastPlatformMsgAt > r.hotelReadAt)
        : !!r.lastHotelMsgAt && (!r.platformReadAt || r.lastHotelMsgAt > r.platformReadAt);
    const ctx = (r.context ?? {}) as Record<string, string | null>;
    return {
      id: r.id,
      number: supportNumber(r.seq),
      tenant,
      property: r.propertyId ? { id: r.propertyId, name: r.propertyName ?? '' } : null,
      openedBy: { id: r.openedById, fullName: r.openedByName, email: r.openedByEmail, role: r.openedByRole },
      subject: r.subject,
      category: r.category,
      priority: r.priority,
      status: r.status as SupportStatus,
      planCode: r.planCode,
      slaHours: r.slaHours,
      firstResponseDueAt: r.firstResponseDue.toISOString(),
      firstRespondedAt: r.firstRespondedAt?.toISOString() ?? null,
      sla: slaState(r),
      assignee: audience === 'PLATFORM' && r.assigneeId ? { id: r.assigneeId, fullName: r.assigneeName ?? '', email: '' } : null,
      context: {
        pageUrl: ctx.pageUrl ?? null, appVersion: ctx.appVersion ?? null, userAgent: ctx.userAgent ?? null,
        propertyName: ctx.propertyName ?? r.propertyName ?? null, userRole: ctx.userRole ?? r.openedByRole,
      },
      lastMessageAt: r.lastMessageAt.toISOString(),
      messageCount: messageCount ?? r._count?.messages ?? 0,
      unread,
      resolvedAt: r.resolvedAt?.toISOString() ?? null,
      createdAt: r.createdAt.toISOString(),
      updatedAt: r.updatedAt.toISOString(),
    };
  }

  private messageView(m: SupportMessage) {
    return {
      id: m.id,
      author: { kind: m.authorKind as 'HOTEL' | 'PLATFORM', id: m.authorId, fullName: m.authorName },
      body: m.body,
      internal: m.internal,
      attachments: ((m.attachments as unknown as StoredAttachment[]) ?? []).map((a) => this.view(a)),
      createdAt: m.createdAt.toISOString(),
    };
  }

  private async tenantRef(tx: Tx, tenantId: string) {
    const t = await tx.tenant.findUnique({ where: { id: tenantId }, select: { id: true, name: true, slug: true } });
    return t ?? { id: tenantId, name: '', slug: '' };
  }

  // ---------------------------------------------------------------------------
  // Hotel side
  // ---------------------------------------------------------------------------

  private hotelWhere(u: AuthUser): Prisma.SupportRequestWhereInput {
    return { tenantId: u.tenantId, ...(!u.permissions?.has('support.view_all') && { openedById: u.userId }) };
  }

  async create(
    u: AuthUser,
    dto: { subject: string; category: string; message: string; priority?: string; attachmentKeys?: string[]; context?: { pageUrl?: string; appVersion?: string } },
    req: AppRequest,
  ) {
    const now = new Date();
    const propertyId = currentPropertyId(u.tenantId) ?? u.propertyId ?? null;
    const property = propertyId ? await this.db.tenant(u.tenantId, (tx) => tx.property.findFirst({ where: { id: propertyId }, select: { name: true } })) : null;
    const planCode = await this.db.control(u.tenantId, async (tx) => (await tx.subscription.findUnique({ where: { tenantId: u.tenantId }, include: { plan: { select: { code: true } } } }))?.plan.code ?? 'starter');
    const slaHours = SLA_HOURS[planCode] ?? 48;
    const ua = req.headers['user-agent'];
    const { request, message } = await this.db.control(u.tenantId, async (tx) => {
      const request = await tx.supportRequest.create({
        data: {
          tenantId: u.tenantId, propertyId, propertyName: property?.name ?? null,
          openedById: u.userId, openedByName: u.fullName, openedByEmail: u.email, openedByRole: u.role,
          subject: dto.subject.trim(), category: dto.category, priority: dto.priority ?? 'NORMAL', status: 'NEW',
          planCode, slaHours, firstResponseDue: new Date(now.getTime() + slaHours * 3_600_000),
          context: {
            pageUrl: dto.context?.pageUrl?.slice(0, 500) ?? null, appVersion: dto.context?.appVersion?.slice(0, 40) ?? null,
            userAgent: (Array.isArray(ua) ? ua[0] : ua)?.slice(0, 300) ?? null, propertyName: property?.name ?? null, userRole: u.role,
            ...(u.impersonation && { impersonationSessionId: u.impersonation.sessionId }),
          },
          lastMessageAt: now, lastHotelMsgAt: now, hotelReadAt: now,
        },
      });
      const id = randomUUID();
      const attachments = await this.claimForHotel(u, dto.attachmentKeys, id);
      const message = await tx.supportMessage.create({
        data: { id, requestId: request.id, tenantId: u.tenantId, authorKind: 'HOTEL', authorId: u.userId, authorName: u.fullName, body: dto.message.trim(), attachments: attachments as unknown as Prisma.InputJsonValue },
      });
      return { request, message };
    });
    const tenant = await this.db.system((tx) => this.tenantRef(tx, u.tenantId));
    await this.notifyPlatform(request, tenant.name, dto.message);
    return { ...this.requestView(request, 'HOTEL', tenant, 1), messages: [this.messageView(message)] };
  }

  /** Hotel attachments are claimed on the platform connection (their rows are platform data). */
  private claimForHotel(u: AuthUser, keys: string[] | undefined, messageId: string) {
    return this.db.system((tx) => this.claim(tx, keys, { kind: 'HOTEL', id: u.userId }, messageId));
  }

  async list(u: AuthUser, q: { status?: string[]; state?: string; page?: number; pageSize?: number }) {
    const page = q.page ?? 1;
    const pageSize = Math.min(q.pageSize ?? 20, 100);
    const where: Prisma.SupportRequestWhereInput = { ...this.hotelWhere(u), ...statusFilter(q.status, q.state, null) };
    const [rows, total] = await this.db.control(u.tenantId, async (tx) => [
      await tx.supportRequest.findMany({ where, orderBy: { lastMessageAt: 'desc' }, skip: (page - 1) * pageSize, take: pageSize, include: { _count: { select: { messages: { where: { internal: false } } } } } }),
      await tx.supportRequest.count({ where }),
    ] as const);
    const tenant = await this.db.system((tx) => this.tenantRef(tx, u.tenantId));
    return { items: rows.map((r) => this.requestView(r, 'HOTEL', tenant)), total, page, pageSize };
  }

  async summary(u: AuthUser) {
    const rows = await this.db.control(u.tenantId, (tx) =>
      tx.supportRequest.findMany({ where: { ...this.hotelWhere(u), status: { in: OPEN_STATUSES } }, select: { lastPlatformMsgAt: true, hotelReadAt: true } }),
    );
    return { open: rows.length, unread: rows.filter((r) => r.lastPlatformMsgAt && (!r.hotelReadAt || r.lastPlatformMsgAt > r.hotelReadAt)).length };
  }

  private async loadForHotel(u: AuthUser, id: string) {
    const r = await this.db.control(u.tenantId, (tx) => tx.supportRequest.findFirst({ where: { id, ...this.hotelWhere(u) } }));
    if (!r) throw AppException.notFound('Support request');
    return r;
  }

  async get(u: AuthUser, id: string) {
    await this.loadForHotel(u, id);
    const r = await this.db.control(u.tenantId, (tx) => tx.supportRequest.update({ where: { id }, data: { hotelReadAt: new Date() } }));
    const messages = await this.db.control(u.tenantId, (tx) => tx.supportMessage.findMany({ where: { requestId: id, internal: false }, orderBy: { createdAt: 'asc' } }));
    const tenant = await this.db.system((tx) => this.tenantRef(tx, u.tenantId));
    return { ...this.requestView(r, 'HOTEL', tenant, messages.length), messages: messages.map((m) => this.messageView(m)) };
  }

  async hotelReply(u: AuthUser, id: string, dto: { body: string; attachmentKeys?: string[] }) {
    const r = await this.loadForHotel(u, id);
    if (r.status === 'CLOSED') throw Err.invalidState(r.status, ['NEW', 'OPEN', 'WAITING_ON_HOTEL', 'RESOLVED'], 'This request');
    const now = new Date();
    const msgId = randomUUID();
    const attachments = await this.claimForHotel(u, dto.attachmentKeys, msgId);
    const message = await this.db.control(u.tenantId, async (tx) => {
      const m = await tx.supportMessage.create({
        data: { id: msgId, requestId: id, tenantId: u.tenantId, authorKind: 'HOTEL', authorId: u.userId, authorName: u.fullName, body: dto.body.trim(), attachments: attachments as unknown as Prisma.InputJsonValue },
      });
      await tx.supportRequest.update({
        where: { id },
        data: { lastMessageAt: now, lastHotelMsgAt: now, hotelReadAt: now, ...(['WAITING_ON_HOTEL', 'RESOLVED'].includes(r.status) && { status: 'OPEN', resolvedAt: null }) },
      });
      return m;
    });
    return this.messageView(message);
  }

  async setHotelStatus(u: AuthUser, id: string, status: 'CLOSED' | 'OPEN') {
    const r = await this.loadForHotel(u, id);
    const updated = await this.db.control(u.tenantId, (tx) =>
      tx.supportRequest.update({ where: { id: r.id }, data: status === 'CLOSED' ? { status: 'CLOSED', resolvedAt: r.resolvedAt ?? new Date() } : { status: 'OPEN', resolvedAt: null } }),
    );
    const tenant = await this.db.system((tx) => this.tenantRef(tx, u.tenantId));
    return this.requestView(updated, 'HOTEL', tenant);
  }

  // ---------------------------------------------------------------------------
  // Platform side
  // ---------------------------------------------------------------------------

  async platformList(p: PlatformPrincipal, q: { status?: string[]; state?: string; category?: string; priority?: string; assigneeId?: string; tenantId?: string; sla?: string; q?: string; page?: number; pageSize?: number }) {
    const page = q.page ?? 1;
    const pageSize = Math.min(q.pageSize ?? 20, 100);
    const now = new Date();
    const where: Prisma.SupportRequestWhereInput = {
      ...statusFilter(q.status, q.state, OPEN_STATUSES),
      ...(q.category && { category: q.category }),
      ...(q.priority && { priority: q.priority }),
      ...(q.tenantId && { tenantId: q.tenantId }),
      ...(q.assigneeId === 'me' ? { assigneeId: p.platformUserId } : q.assigneeId === 'none' ? { assigneeId: null } : q.assigneeId ? { assigneeId: q.assigneeId } : {}),
      ...(q.sla === 'BREACHED' && { firstRespondedAt: null, firstResponseDue: { lt: now } }),
      ...(q.q && { OR: [{ subject: { contains: q.q, mode: 'insensitive' as const } }, { openedByName: { contains: q.q, mode: 'insensitive' as const } }] }),
    };
    return this.db.system(async (tx) => {
      const rows = await tx.supportRequest.findMany({
        where, orderBy: [{ firstResponseDue: 'asc' }, { createdAt: 'asc' }], skip: (page - 1) * pageSize, take: pageSize,
        include: { _count: { select: { messages: true } } },
      });
      const total = await tx.supportRequest.count({ where });
      const tenants = await tx.tenant.findMany({ where: { id: { in: [...new Set(rows.map((r) => r.tenantId))] } }, select: { id: true, name: true, slug: true } });
      const byId = new Map(tenants.map((t) => [t.id, t]));
      return { items: rows.map((r) => this.requestView(r, 'PLATFORM', byId.get(r.tenantId) ?? { id: r.tenantId, name: '', slug: '' })), total, page, pageSize };
    });
  }

  async platformSummary(p: PlatformPrincipal) {
    const now = new Date();
    return this.db.system(async (tx) => {
      const open = await tx.supportRequest.findMany({ where: { status: { in: OPEN_STATUSES } }, select: { status: true, assigneeId: true, createdAt: true, firstResponseDue: true, firstRespondedAt: true } });
      return {
        new: open.filter((r) => r.status === 'NEW').length,
        open: open.filter((r) => r.status === 'OPEN').length,
        waitingOnHotel: open.filter((r) => r.status === 'WAITING_ON_HOTEL').length,
        overdue: open.filter((r) => slaState(r, now) === 'BREACHED').length,
        dueSoon: open.filter((r) => slaState(r, now) === 'DUE_SOON').length,
        mine: open.filter((r) => r.assigneeId === p.platformUserId).length,
      };
    });
  }

  async platformGet(id: string) {
    return this.db.system(async (tx) => {
      const r = await tx.supportRequest.update({ where: { id }, data: { platformReadAt: new Date() } }).catch(() => null);
      if (!r) throw AppException.notFound('Support request');
      const messages = await tx.supportMessage.findMany({ where: { requestId: id }, orderBy: { createdAt: 'asc' } });
      const tenant = await this.tenantRef(tx, r.tenantId);
      const staff = await this.db.systemFor(r.tenantId, (t) => t.user.findMany({ where: { tenantId: r.tenantId, isActive: true }, select: { id: true, fullName: true, role: true }, orderBy: { fullName: 'asc' } }));
      return { ...this.requestView(r, 'PLATFORM', tenant, messages.length), messages: messages.map((m) => this.messageView(m)), tenantStaff: staff };
    });
  }

  async platformUpdate(p: PlatformPrincipal, id: string, dto: { status?: string; priority?: string; assigneeId?: string | null; category?: string }) {
    let assigneeName: string | null | undefined;
    if (dto.assigneeId) {
      const a = await this.db.system((tx) => tx.platformUser.findFirst({ where: { id: dto.assigneeId!, isActive: true }, select: { fullName: true } }));
      if (!a) throw Err.validation('assigneeId', 'Unknown or inactive platform user');
      assigneeName = a.fullName;
    } else if (dto.assigneeId === null) assigneeName = null;
    const r = await this.db.system(async (tx) => {
      const cur = await tx.supportRequest.findUnique({ where: { id } });
      if (!cur) throw AppException.notFound('Support request');
      return tx.supportRequest.update({
        where: { id },
        data: {
          ...(dto.status && { status: dto.status, ...(['RESOLVED', 'CLOSED'].includes(dto.status) ? { resolvedAt: cur.resolvedAt ?? new Date() } : { resolvedAt: null }) }),
          ...(dto.priority && { priority: dto.priority }),
          ...(dto.category && { category: dto.category }),
          ...(dto.assigneeId !== undefined && { assigneeId: dto.assigneeId, assigneeName }),
        },
      });
    });
    const tenant = await this.db.system((tx) => this.tenantRef(tx, r.tenantId));
    return this.requestView(r, 'PLATFORM', tenant);
  }

  async platformReply(p: PlatformPrincipal, id: string, dto: { body: string; internal?: boolean; attachmentKeys?: string[] }) {
    const now = new Date();
    const msgId = randomUUID();
    const { r, m } = await this.db.system(async (tx) => {
      const cur = await tx.supportRequest.findUnique({ where: { id } });
      if (!cur) throw AppException.notFound('Support request');
      const attachments = await this.claim(tx, dto.attachmentKeys, { kind: 'PLATFORM', id: p.platformUserId }, msgId);
      const m = await tx.supportMessage.create({
        data: { id: msgId, requestId: id, tenantId: cur.tenantId, authorKind: 'PLATFORM', authorId: p.platformUserId, authorName: p.fullName, body: dto.body.trim(), internal: !!dto.internal, attachments: attachments as unknown as Prisma.InputJsonValue },
      });
      const r = dto.internal
        ? await tx.supportRequest.update({ where: { id }, data: { platformReadAt: now } })
        : await tx.supportRequest.update({
            where: { id },
            data: {
              lastMessageAt: now, lastPlatformMsgAt: now, platformReadAt: now,
              ...(!cur.firstRespondedAt && { firstRespondedAt: now }),
              ...(['NEW', 'OPEN'].includes(cur.status) && { status: 'WAITING_ON_HOTEL' }),
              ...(!cur.assigneeId && { assigneeId: p.platformUserId, assigneeName: p.fullName }),
            },
          });
      return { r, m };
    });
    if (!dto.internal) await this.notifyHotel(r, p.fullName, dto.body);
    return this.messageView(m);
  }

  /** Adds an internal note (used when a support session starts from a request). */
  async internalNote(requestId: string, p: PlatformPrincipal, body: string) {
    await this.db.system(async (tx) => {
      const r = await tx.supportRequest.findUnique({ where: { id: requestId } });
      if (!r) return;
      await tx.supportMessage.create({ data: { requestId, tenantId: r.tenantId, authorKind: 'PLATFORM', authorId: p.platformUserId, authorName: p.fullName, body, internal: true } });
    });
  }

  // ---------------------------------------------------------------------------
  // Notifications
  // ---------------------------------------------------------------------------

  private brand() {
    return { appName: this.config.get('APP_NAME'), appDomain: this.config.get('APP_DOMAIN'), supportEmail: this.config.get('SUPPORT_EMAIL') };
  }

  private platformUrl(): string {
    return this.config.get('PLATFORM_APP_URL') ?? this.config.get('PLATFORM_ORIGINS')[0] ?? 'http://localhost:3002';
  }

  private async notifyPlatform(r: SupportRequest, hotelName: string, message: string) {
    try {
      const rendered = renderTemplate(this.brand(), {
        template: 'SUPPORT_NEW', number: supportNumber(r.seq), hotelName, subject: r.subject, category: r.category, priority: r.priority,
        openedBy: `${r.openedByName} (${r.openedByRole})`, excerpt: message.slice(0, 400), slaHours: r.slaHours, consoleUrl: `${this.platformUrl()}/support/${r.id}`,
      });
      await this.notifications.send([{ tenantId: null, template: 'SUPPORT_NEW', channel: 'EMAIL', audience: 'PLATFORM', to: this.config.get('SUPPORT_EMAIL'), subject: rendered.subject, text: rendered.text, html: rendered.html }]);
    } catch (e) {
      this.logger.warn(`Support notification failed: ${(e as Error).message}`);
    }
  }

  private async notifyHotel(r: SupportRequest, fromName: string, body: string) {
    try {
      const rendered = renderTemplate(this.brand(), {
        template: 'SUPPORT_REPLY', number: supportNumber(r.seq), subject: r.subject, fromName: `${fromName} from ${this.config.get('APP_NAME')} support`,
        excerpt: body.slice(0, 600), adminUrl: `${this.config.get('ADMIN_URL')}/support/${r.id}`,
      });
      await this.notifications.send([{ tenantId: r.tenantId, template: 'SUPPORT_REPLY', channel: 'EMAIL', audience: 'HOTEL', to: r.openedByEmail, subject: rendered.subject, text: rendered.text, html: rendered.html }]);
    } catch (e) {
      this.logger.warn(`Support reply notification failed: ${(e as Error).message}`);
    }
  }
}
