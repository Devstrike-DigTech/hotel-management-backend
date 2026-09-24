import { Injectable, Logger } from '@nestjs/common';
import type { Announcement, Prisma } from '../../../generated/prisma/client.js';
import type { AuthUser, PlatformPrincipal } from '../../../common/auth-types.js';
import { AppException } from '../../../common/errors/app-exception.js';
import { humanDateTime } from '../../../common/time/lagos.js';
import { AppConfigService } from '../../../config/app-config.service.js';
import { DbService } from '../../../prisma/db.service.js';
import { NotificationService } from '../../notifications/notification.service.js';
import { renderTemplate } from '../../notifications/templates/templates.js';
import { appError, Err } from '../../ops/ops.helpers.js';

export const SEVERITIES = ['INFO', 'SUCCESS', 'WARNING', 'CRITICAL', 'MAINTENANCE'] as const;

export type Audience =
  | { kind: 'ALL' }
  | { kind: 'PLANS'; planCodes: string[] }
  | { kind: 'CITIES'; cities: string[] }
  | { kind: 'TENANTS'; tenantIds: string[] };

export type AnnouncementState = 'DRAFT' | 'SCHEDULED' | 'ACTIVE' | 'ENDED' | 'ARCHIVED';

export function announcementState(a: Pick<Announcement, 'archivedAt' | 'publishedAt' | 'endedAt' | 'endsAt' | 'startsAt'>, now = new Date()): AnnouncementState {
  if (a.archivedAt) return 'ARCHIVED';
  if (!a.publishedAt) return 'DRAFT';
  if (a.endedAt || (a.endsAt && a.endsAt <= now)) return 'ENDED';
  if (a.startsAt > now) return 'SCHEDULED';
  return 'ACTIVE';
}

export interface AudienceTenant {
  id: string;
  planCode: string | null;
  cities: string[];
}

/** Whether a tenant is in an announcement's audience. */
export function inAudience(a: Audience, t: AudienceTenant): boolean {
  switch (a.kind) {
    case 'ALL':
      return true;
    case 'PLANS':
      return !!t.planCode && a.planCodes.includes(t.planCode);
    case 'CITIES': {
      const wanted = a.cities.map((c) => c.trim().toLowerCase());
      return t.cities.some((c) => wanted.includes(c.toLowerCase()));
    }
    case 'TENANTS':
      return a.tenantIds.includes(t.id);
  }
}

export function parseAudience(v: unknown): Audience {
  const a = (v ?? {}) as Record<string, unknown>;
  const list = (k: string) => (Array.isArray(a[k]) ? (a[k] as unknown[]).filter((x): x is string => typeof x === 'string') : []);
  switch (a.kind) {
    case 'PLANS':
      return { kind: 'PLANS', planCodes: list('planCodes') };
    case 'CITIES':
      return { kind: 'CITIES', cities: list('cities') };
    case 'TENANTS':
      return { kind: 'TENANTS', tenantIds: list('tenantIds') };
    default:
      return { kind: 'ALL' };
  }
}

export interface AnnouncementInput {
  title?: string;
  body?: string;
  severity?: string;
  audience?: Audience;
  channels?: { inApp?: boolean; email?: boolean };
  startsAt?: string;
  endsAt?: string | null;
  dismissible?: boolean;
  link?: { label: string; url: string } | null;
}

/**
 * Platform announcements (M6): targeted in-app banners (all tenants, plans,
 * cities or chosen tenants) with a schedule window, optional email to each
 * targeted hotel's owners and managers, per-user seen / dismissed receipts
 * and stats.
 */
@Injectable()
export class AnnouncementsService {
  private readonly logger = new Logger(AnnouncementsService.name);

  constructor(
    private readonly db: DbService,
    private readonly config: AppConfigService,
    private readonly notifications: NotificationService,
  ) {}

  /** Every live tenant with its plan and cities (tenant city and property cities). */
  private async audienceTenants(): Promise<(AudienceTenant & { name: string; slug: string })[]> {
    return this.db.system(async (tx) => {
      const tenants = await tx.tenant.findMany({ where: { lifecycle: 'ACTIVE' }, include: { subscription: { include: { plan: { select: { code: true } } } } } });
      const listings = await tx.publicListing.findMany({ select: { tenantId: true, city: true } });
      return tenants.map((t) => ({
        id: t.id, name: t.name, slug: t.slug, planCode: t.subscription?.plan.code ?? null,
        cities: [...new Set([t.city, ...listings.filter((l) => l.tenantId === t.id).map((l) => l.city)])],
      }));
    });
  }

  async preview(audience: Audience) {
    const all = await this.audienceTenants();
    const hits = all.filter((t) => inAudience(audience, t));
    const byPlan: Record<string, number> = {};
    for (const t of hits) byPlan[t.planCode ?? 'none'] = (byPlan[t.planCode ?? 'none'] ?? 0) + 1;
    return { tenantCount: hits.length, sample: hits.slice(0, 10).map((t) => ({ id: t.id, name: t.name, slug: t.slug })), byPlan };
  }

  private async stats(a: Announcement) {
    const receipts = await this.db.system((tx) => tx.announcementReceipt.findMany({ where: { announcementId: a.id }, select: { seenAt: true, dismissedAt: true } }));
    return {
      targetedTenants: a.targetedTenants,
      emailsSent: a.emailsSent,
      seenUsers: receipts.filter((r) => r.seenAt).length,
      dismissedUsers: receipts.filter((r) => r.dismissedAt).length,
    };
  }

  private async view(a: Announcement) {
    return {
      id: a.id,
      title: a.title,
      body: a.body,
      severity: a.severity,
      audience: parseAudience(a.audience),
      channels: { inApp: a.inApp, email: a.email },
      startsAt: a.startsAt.toISOString(),
      endsAt: a.endsAt?.toISOString() ?? null,
      dismissible: a.dismissible,
      link: a.linkLabel && a.linkUrl ? { label: a.linkLabel, url: a.linkUrl } : null,
      state: announcementState(a),
      publishedAt: a.publishedAt?.toISOString() ?? null,
      emailedAt: a.emailedAt?.toISOString() ?? null,
      createdBy: a.createdById ? { id: a.createdById, fullName: a.createdByName ?? '', email: '' } : null,
      createdAt: a.createdAt.toISOString(),
      updatedAt: a.updatedAt.toISOString(),
      stats: await this.stats(a),
    };
  }

  private validate(dto: AnnouncementInput, partial: boolean) {
    if (!partial || dto.startsAt || dto.endsAt) {
      const start = dto.startsAt ? new Date(dto.startsAt) : null;
      const end = dto.endsAt ? new Date(dto.endsAt) : null;
      if (start && end && end <= start) throw Err.validation('endsAt', 'The end must be after the start');
    }
    if (dto.audience?.kind === 'TENANTS' && !dto.audience.tenantIds.length) throw Err.validation('audience', 'Choose at least one hotel');
    if (dto.audience?.kind === 'PLANS' && !dto.audience.planCodes.length) throw Err.validation('audience', 'Choose at least one plan');
    if (dto.audience?.kind === 'CITIES' && !dto.audience.cities.length) throw Err.validation('audience', 'Choose at least one city');
    if (dto.link && !dto.link.url.startsWith('https://')) throw Err.validation('link', 'Links must start with https://');
  }

  private data(dto: AnnouncementInput): Prisma.AnnouncementUncheckedUpdateInput {
    return {
      ...(dto.title !== undefined && { title: dto.title.trim() }),
      ...(dto.body !== undefined && { body: dto.body.trim() }),
      ...(dto.severity !== undefined && { severity: dto.severity }),
      ...(dto.audience !== undefined && { audience: dto.audience as unknown as Prisma.InputJsonValue }),
      ...(dto.channels?.inApp !== undefined && { inApp: dto.channels.inApp }),
      ...(dto.channels?.email !== undefined && { email: dto.channels.email }),
      ...(dto.startsAt !== undefined && { startsAt: new Date(dto.startsAt) }),
      ...(dto.endsAt !== undefined && { endsAt: dto.endsAt ? new Date(dto.endsAt) : null }),
      ...(dto.dismissible !== undefined && { dismissible: dto.dismissible }),
      ...(dto.link !== undefined && { linkLabel: dto.link?.label ?? null, linkUrl: dto.link?.url ?? null }),
    };
  }

  async list(state?: string) {
    const rows = await this.db.system((tx) => tx.announcement.findMany({ orderBy: [{ startsAt: 'desc' }, { createdAt: 'desc' }], take: 200 }));
    const filtered = state ? rows.filter((r) => announcementState(r) === state) : rows.filter((r) => !r.archivedAt);
    return Promise.all(filtered.map((r) => this.view(r)));
  }

  async get(id: string) {
    const a = await this.db.system((tx) => tx.announcement.findUnique({ where: { id } }));
    if (!a) throw AppException.notFound('Announcement');
    return a;
  }

  async create(p: PlatformPrincipal, dto: AnnouncementInput & { title: string; body: string }) {
    this.validate(dto, false);
    const a = await this.db.system((tx) =>
      tx.announcement.create({
        data: {
          ...(this.data(dto) as Prisma.AnnouncementUncheckedCreateInput),
          title: dto.title.trim(),
          body: dto.body.trim(),
          startsAt: dto.startsAt ? new Date(dto.startsAt) : new Date(),
          createdById: p.platformUserId,
          createdByName: p.fullName,
        },
      }),
    );
    return this.view(a);
  }

  async update(id: string, dto: AnnouncementInput) {
    const a = await this.get(id);
    const state = announcementState(a);
    if (state === 'ARCHIVED' || state === 'ENDED') throw Err.invalidState(state, ['DRAFT', 'SCHEDULED', 'ACTIVE'], 'This announcement');
    if (state === 'ACTIVE') {
      const allowed = new Set(['title', 'body', 'endsAt', 'link', 'dismissible']);
      const bad = Object.keys(dto).filter((k) => (dto as Record<string, unknown>)[k] !== undefined && !allowed.has(k));
      if (bad.length) throw appError(409, 'INVALID_STATE', 'A live announcement can only change its title, text, link and end time', { status: state, fields: bad });
    }
    this.validate(dto, true);
    const updated = await this.db.system((tx) => tx.announcement.update({ where: { id }, data: this.data(dto) }));
    return this.view(updated);
  }

  async publish(id: string) {
    const a = await this.get(id);
    if (a.publishedAt || a.archivedAt) throw Err.invalidState(announcementState(a), ['DRAFT'], 'This announcement');
    const hits = (await this.audienceTenants()).filter((t) => inAudience(parseAudience(a.audience), t));
    const published = await this.db.system((tx) => tx.announcement.update({ where: { id }, data: { publishedAt: new Date(), targetedTenants: hits.length } }));
    if (published.email && published.startsAt <= new Date()) await this.sendEmails(published.id);
    return this.view(await this.get(id));
  }

  async end(id: string) {
    const a = await this.get(id);
    const updated = await this.db.system((tx) => tx.announcement.update({ where: { id: a.id }, data: { endedAt: new Date() } }));
    return this.view(updated);
  }

  async archive(id: string) {
    await this.get(id);
    await this.db.system((tx) => tx.announcement.update({ where: { id }, data: { archivedAt: new Date() } }));
    return { success: true };
  }

  async statsDetail(id: string) {
    const a = await this.get(id);
    const all = await this.audienceTenants();
    const hits = all.filter((t) => inAudience(parseAudience(a.audience), t));
    const receipts = await this.db.system((tx) => tx.announcementReceipt.findMany({ where: { announcementId: id } }));
    const emailed = await this.db.system((tx) =>
      tx.notificationLog.findMany({ where: { template: 'ANNOUNCEMENT', dedupeKey: { startsWith: `ANNOUNCEMENT:${id}:` } }, select: { tenantId: true } }),
    );
    const emailedTenants = new Set(emailed.map((e) => e.tenantId));
    return {
      ...(await this.stats(a)),
      byTenant: hits.map((t) => ({
        tenant: { id: t.id, name: t.name, slug: t.slug },
        seen: receipts.filter((r) => r.tenantId === t.id && r.seenAt).length,
        dismissed: receipts.filter((r) => r.tenantId === t.id && r.dismissedAt).length,
        emailed: emailedTenants.has(t.id),
      })),
    };
  }

  /** Emails the owners and managers of every targeted hotel (once per announcement). */
  async sendEmails(id: string): Promise<number> {
    const a = await this.get(id);
    if (!a.email || a.emailedAt || announcementState(a) !== 'ACTIVE') return 0;
    const claimed = await this.db.system((tx) => tx.announcement.updateMany({ where: { id, emailedAt: null }, data: { emailedAt: new Date() } }));
    if (!claimed.count) return 0;
    const hits = (await this.audienceTenants()).filter((t) => inAudience(parseAudience(a.audience), t));
    const brand = { appName: this.config.get('APP_NAME'), appDomain: this.config.get('APP_DOMAIN'), supportEmail: this.config.get('SUPPORT_EMAIL') };
    const rendered = renderTemplate(brand, {
      template: 'ANNOUNCEMENT', title: a.title, body: a.body, severity: a.severity,
      link: a.linkLabel && a.linkUrl ? { label: a.linkLabel, url: a.linkUrl } : null,
      whenHuman: a.severity === 'MAINTENANCE' ? `${humanDateTime(a.startsAt)}${a.endsAt ? ` to ${humanDateTime(a.endsAt)}` : ''}` : null,
    });
    let sent = 0;
    for (const t of hits) {
      try {
        const people = await this.db.systemFor(t.id, (tx) => tx.user.findMany({ where: { tenantId: t.id, isActive: true, role: { in: ['OWNER', 'MANAGER'] } }, select: { email: true } }));
        const ids = await this.notifications.send(
          people.map((u) => ({
            tenantId: t.id, template: 'ANNOUNCEMENT' as const, channel: 'EMAIL' as const, audience: 'HOTEL' as const, to: u.email,
            subject: rendered.subject, text: rendered.text, html: rendered.html, dedupeKey: `ANNOUNCEMENT:${a.id}:${t.id}:${u.email}`,
          })),
        );
        sent += ids.length;
      } catch (e) {
        this.logger.warn(`Announcement email to ${t.id} failed: ${(e as Error).message}`);
      }
    }
    await this.db.system((tx) => tx.announcement.update({ where: { id }, data: { emailsSent: sent } }));
    return sent;
  }

  /** Job (every minute): emails announcements whose window has started. */
  async emailDue(): Promise<{ sent: number }> {
    const now = new Date();
    const due = await this.db.system((tx) => tx.announcement.findMany({ where: { email: true, emailedAt: null, publishedAt: { not: null }, archivedAt: null, endedAt: null, startsAt: { lte: now } }, select: { id: true } }));
    let sent = 0;
    for (const a of due) sent += await this.sendEmails(a.id);
    return { sent };
  }

  // ---------------------------------------------------------------------------
  // Hotel side
  // ---------------------------------------------------------------------------

  async forHotel(u: AuthUser) {
    const now = new Date();
    const [live, me] = await Promise.all([
      this.db.system((tx) =>
        tx.announcement.findMany({
          where: { publishedAt: { not: null }, archivedAt: null, endedAt: null, inApp: true, startsAt: { lte: now }, OR: [{ endsAt: null }, { endsAt: { gt: now } }] },
          orderBy: { startsAt: 'desc' },
        }),
      ),
      this.audienceTenants().then((all) => all.find((t) => t.id === u.tenantId)),
    ]);
    if (!me) return [];
    const mine = live.filter((a) => inAudience(parseAudience(a.audience), me));
    const dismissed = await this.db.control(u.tenantId, (tx) =>
      tx.announcementReceipt.findMany({ where: { userId: u.userId, dismissedAt: { not: null }, announcementId: { in: mine.map((a) => a.id) } }, select: { announcementId: true } }),
    );
    const gone = new Set(dismissed.map((d) => d.announcementId));
    const rank: Record<string, number> = { CRITICAL: 0, MAINTENANCE: 1, WARNING: 2, INFO: 3, SUCCESS: 4 };
    return mine
      .filter((a) => !gone.has(a.id))
      .sort((a, b) => (rank[a.severity] ?? 9) - (rank[b.severity] ?? 9))
      .map((a) => ({
        id: a.id, title: a.title, body: a.body, severity: a.severity,
        link: a.linkLabel && a.linkUrl ? { label: a.linkLabel, url: a.linkUrl } : null,
        dismissible: a.dismissible, startsAt: a.startsAt.toISOString(), endsAt: a.endsAt?.toISOString() ?? null,
      }));
  }

  private async targeted(u: AuthUser, id: string) {
    const list = await this.forHotel(u);
    const a = list.find((x) => x.id === id);
    if (!a) throw AppException.notFound('Announcement');
    return a;
  }

  async seen(u: AuthUser, id: string) {
    await this.targeted(u, id);
    await this.db.control(u.tenantId, (tx) =>
      tx.announcementReceipt.upsert({
        where: { announcementId_userId: { announcementId: id, userId: u.userId } },
        create: { announcementId: id, tenantId: u.tenantId, userId: u.userId, seenAt: new Date() },
        update: { seenAt: new Date() },
      }),
    );
    return { success: true };
  }

  async dismiss(u: AuthUser, id: string) {
    const a = await this.targeted(u, id);
    if (!a.dismissible) throw appError(409, 'INVALID_STATE', 'This announcement cannot be dismissed', { status: 'NOT_DISMISSIBLE', allowed: [] });
    const now = new Date();
    await this.db.control(u.tenantId, (tx) =>
      tx.announcementReceipt.upsert({
        where: { announcementId_userId: { announcementId: id, userId: u.userId } },
        create: { announcementId: id, tenantId: u.tenantId, userId: u.userId, seenAt: now, dismissedAt: now },
        update: { dismissedAt: now },
      }),
    );
    return { success: true };
  }
}
