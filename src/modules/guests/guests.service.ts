import { HttpStatus, Inject, Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { Guest, Prisma } from '../../generated/prisma/client.js';
import type { AuthUser } from '../../common/auth-types.js';
import { FieldCipher, last4Of, maskIdNumber } from '../../common/crypto/field-cipher.js';
import { signToken, verifyToken } from '../../common/crypto/signed-token.js';
import { AppException } from '../../common/errors/app-exception.js';
import { addDays, diffDays, fromDbDate, lagosStartOfDay, isIsoDate, dbDate } from '../../common/time/lagos.js';
import { normalisePhone } from '../../common/utils/phone.js';
import { AppConfigService } from '../../config/app-config.service.js';
import { DbService, type Tx } from '../../prisma/db.service.js';
import { AuditService, userActor } from '../audit/audit.service.js';
import { appError, Err, isManager, paginate } from '../ops/ops.helpers.js';
import { OBJECT_STORAGE, type ObjectStorage } from '../storage/object-storage.js';
import type { GuestInputDto, GuestQueryDto, GuestUpdateDto, RegisterQueryDto } from './guests.dto.js';

const ALLOWED_TYPES: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'application/pdf': 'pdf',
};
export const MAX_ID_IMAGE_BYTES = 5 * 1024 * 1024;
const FILE_URL_TTL_S = 10 * 60;

interface FilePayload {
  k: string;
  tid: string;
  exp: number;
}

export interface UploadedFileLike {
  buffer: Buffer;
  mimetype: string;
  size: number;
}

const REGISTER_COLUMNS = [
  'checkedInAt', 'checkedOutAt', 'roomNumber', 'reservationCode', 'guestName', 'phone', 'nationality', 'gender',
  'idType', 'idNumber', 'address', 'arrivingFrom', 'goingTo', 'purpose', 'vehiclePlate', 'company', 'adults',
  'children', 'registeredBy',
] as const;

/**
 * Guest records (NDPA-aware): ID numbers encrypted at rest with AES-256-GCM,
 * masked everywhere except an audited reveal; export and anonymise on request.
 */
@Injectable()
export class GuestsService {
  private readonly cipher: FieldCipher;

  constructor(
    private readonly db: DbService,
    private readonly audit: AuditService,
    private readonly config: AppConfigService,
    @Inject(OBJECT_STORAGE) private readonly storage: ObjectStorage,
  ) {
    this.cipher = new FieldCipher(config.get('GUEST_DATA_KEY'));
  }

  // ---------------------------------------------------------------------------
  // Mapping
  // ---------------------------------------------------------------------------

  toView(g: Guest, stats?: { stayCount: number; lastStayAt: Date | null }) {
    return {
      id: g.id,
      fullName: g.fullName,
      phone: g.phone,
      email: g.email,
      gender: g.gender,
      dateOfBirth: g.dateOfBirth ? fromDbDate(g.dateOfBirth) : null,
      nationality: g.nationality,
      address: g.address,
      idType: g.idType,
      idNumberMasked: maskIdNumber(g.idNumberLast4),
      hasIdImage: !!g.idImageKey,
      vehiclePlate: g.vehiclePlate,
      company: g.company,
      vip: g.vip,
      notes: g.notes,
      consentAt: g.consentAt?.toISOString() ?? null,
      marketingOptIn: g.marketingOptIn,
      anonymisedAt: g.anonymisedAt?.toISOString() ?? null,
      stayCount: stats?.stayCount ?? 0,
      lastStayAt: stats?.lastStayAt?.toISOString() ?? null,
      createdAt: g.createdAt.toISOString(),
      updatedAt: g.updatedAt.toISOString(),
    };
  }

  async stats(tx: Tx, guestIds: string[]) {
    if (!guestIds.length) return new Map<string, { stayCount: number; lastStayAt: Date | null }>();
    const rows = await tx.reservation.groupBy({
      by: ['guestId'],
      where: { guestId: { in: guestIds }, status: { in: ['CHECKED_IN', 'CHECKED_OUT'] } },
      _count: { _all: true },
      _max: { arrivalAt: true },
    });
    return new Map(rows.map((r) => [r.guestId, { stayCount: r._count._all, lastStayAt: r._max.arrivalAt }]));
  }

  decryptIdNumber(g: Guest): string | null {
    if (!g.idNumberEnc) return null;
    return this.cipher.decrypt(g.idNumberEnc, g.tenantId);
  }

  // ---------------------------------------------------------------------------
  // Writes shared with reservations / check-in
  // ---------------------------------------------------------------------------

  private phoneOrThrow(phone: string): string {
    const p = normalisePhone(phone);
    if (!p) throw Err.validation('phone', 'Enter a valid phone number (Nigerian numbers like 0803 123 4567, others with +country code)');
    return p;
  }

  private data(tenantId: string, dto: GuestUpdateDto): Prisma.GuestUncheckedUpdateInput {
    if (dto.dateOfBirth && !isIsoDate(dto.dateOfBirth)) throw Err.validation('dateOfBirth', 'dateOfBirth must be a real date');
    return {
      ...(dto.fullName !== undefined && { fullName: dto.fullName.trim() }),
      ...(dto.phone !== undefined && { phone: this.phoneOrThrow(dto.phone) }),
      ...(dto.email !== undefined && { email: dto.email.toLowerCase() || null }),
      ...(dto.gender !== undefined && { gender: dto.gender }),
      ...(dto.dateOfBirth !== undefined && { dateOfBirth: dbDate(dto.dateOfBirth) }),
      ...(dto.nationality !== undefined && { nationality: dto.nationality }),
      ...(dto.address !== undefined && { address: dto.address || null }),
      ...(dto.idType !== undefined && { idType: dto.idType }),
      ...(dto.idNumber !== undefined && {
        idNumberEnc: this.cipher.encrypt(dto.idNumber.trim(), tenantId),
        idNumberLast4: last4Of(dto.idNumber),
      }),
      ...(dto.vehiclePlate !== undefined && { vehiclePlate: dto.vehiclePlate.toUpperCase() || null }),
      ...(dto.company !== undefined && { company: dto.company || null }),
      ...(dto.vip !== undefined && { vip: dto.vip }),
      ...(dto.notes !== undefined && { notes: dto.notes }),
      ...(dto.consent === true && { consentAt: new Date() }),
      ...(dto.marketingOptIn !== undefined && { marketingOptIn: dto.marketingOptIn }),
    };
  }

  async createTx(tx: Tx, tenantId: string, dto: GuestInputDto): Promise<Guest> {
    const phone = this.phoneOrThrow(dto.phone);
    const existing = await tx.guest.findFirst({ where: { tenantId, phone } });
    if (existing) {
      throw appError(HttpStatus.CONFLICT, 'GUEST_EXISTS', 'A guest with this phone number already exists', { guestId: existing.id });
    }
    return tx.guest.create({
      data: { ...(this.data(tenantId, dto) as Prisma.GuestUncheckedCreateInput), tenantId, fullName: dto.fullName.trim(), phone },
    });
  }

  /** Finds a guest by phone or creates one (fields of an existing guest are left alone). */
  async findOrCreateTx(tx: Tx, tenantId: string, dto: GuestInputDto): Promise<Guest> {
    const phone = this.phoneOrThrow(dto.phone);
    const existing = await tx.guest.findFirst({ where: { tenantId, phone } });
    if (existing) {
      if (existing.anonymisedAt) throw this.anonymised();
      return existing;
    }
    return this.createTx(tx, tenantId, dto);
  }

  async updateTx(tx: Tx, tenantId: string, guest: Guest, dto: GuestUpdateDto): Promise<Guest> {
    if (guest.anonymisedAt) throw this.anonymised();
    const data = this.data(tenantId, dto);
    if (typeof data.phone === 'string' && data.phone !== guest.phone) {
      const clash = await tx.guest.findFirst({ where: { tenantId, phone: data.phone, id: { not: guest.id } } });
      if (clash) throw appError(HttpStatus.CONFLICT, 'GUEST_EXISTS', 'Another guest has this phone number', { guestId: clash.id });
    }
    if (!Object.keys(data).length) return guest;
    return tx.guest.update({ where: { id: guest.id }, data });
  }

  anonymised() {
    return appError(HttpStatus.CONFLICT, 'GUEST_ANONYMISED', 'This guest record was anonymised on request and cannot be used');
  }

  async load(tx: Tx, tenantId: string, id: string): Promise<Guest> {
    const g = await tx.guest.findFirst({ where: { id, tenantId } });
    if (!g) throw AppException.notFound('Guest');
    return g;
  }

  // ---------------------------------------------------------------------------
  // API
  // ---------------------------------------------------------------------------

  list(user: AuthUser, q: GuestQueryDto) {
    const pg = paginate(q.page, q.pageSize);
    return this.db.tenant(user.tenantId, async (tx) => {
      const digits = q.q?.replace(/\D/g, '') ?? '';
      const where: Prisma.GuestWhereInput = {
        tenantId: user.tenantId,
        ...(q.vip && { vip: q.vip === 'true' }),
        ...(q.q && {
          OR: [
            { fullName: { contains: q.q, mode: 'insensitive' } },
            { email: { contains: q.q, mode: 'insensitive' } },
            { company: { contains: q.q, mode: 'insensitive' } },
            ...(digits.length >= 4 ? [{ phone: { contains: digits.replace(/^0/, '') } }] : []),
          ],
        }),
      };
      const rows = await tx.guest.findMany({ where, orderBy: [{ updatedAt: 'desc' }], skip: pg.skip, take: pg.take });
      const total = await tx.guest.count({ where });
      const stats = await this.stats(tx, rows.map((r) => r.id));
      return { items: rows.map((g) => this.toView(g, stats.get(g.id))), total, page: pg.page, pageSize: pg.pageSize };
    });
  }

  lookup(user: AuthUser, phone: string) {
    const p = this.phoneOrThrow(phone);
    return this.db.tenant(user.tenantId, async (tx) => {
      const g = await tx.guest.findFirst({ where: { tenantId: user.tenantId, phone: p } });
      if (!g) throw AppException.notFound('Guest');
      const stats = await this.stats(tx, [g.id]);
      return this.toView(g, stats.get(g.id));
    });
  }

  create(user: AuthUser, dto: GuestInputDto, ip?: string) {
    return this.db.tenant(user.tenantId, async (tx) => {
      const g = await this.createTx(tx, user.tenantId, dto);
      await this.audit.record(tx, {
        tenantId: user.tenantId,
        actor: userActor(user),
        action: 'guest.created',
        entityType: 'guest',
        entityId: g.id,
        metadata: { fullName: g.fullName },
        ip,
      });
      return this.toView(g);
    });
  }

  update(user: AuthUser, id: string, dto: GuestUpdateDto, ip?: string) {
    return this.db.tenant(user.tenantId, async (tx) => {
      const g = await this.updateTx(tx, user.tenantId, await this.load(tx, user.tenantId, id), dto);
      await this.audit.record(tx, {
        tenantId: user.tenantId,
        actor: userActor(user),
        action: 'guest.updated',
        entityType: 'guest',
        entityId: id,
        metadata: { fields: Object.keys(dto).filter((f) => f !== 'idNumber').concat(dto.idNumber ? ['idNumber'] : []) },
        ip,
      });
      const stats = await this.stats(tx, [g.id]);
      return this.toView(g, stats.get(g.id));
    });
  }

  /** Signed, short-lived URL for an ID image (usable in <img src>). */
  fileUrl(tenantId: string, key: string): string {
    const token = signToken<FilePayload>(this.config.get('SHARE_TOKEN_SECRET'), 'file', {
      k: key,
      tid: tenantId,
      exp: Math.floor(Date.now() / 1000) + FILE_URL_TTL_S,
    });
    return `${this.config.get('API_PUBLIC_URL').replace(/\/$/, '')}/api/v1/files/${token}`;
  }

  async readFile(token: string) {
    const res = verifyToken<FilePayload>(this.config.get('SHARE_TOKEN_SECRET'), 'file', token);
    if (!res.ok) {
      if (res.reason === 'expired') throw appError(HttpStatus.GONE, 'LINK_EXPIRED', 'This link has expired');
      throw AppException.notFound('File');
    }
    if (!res.payload.k.startsWith(`tenants/${res.payload.tid}/`)) throw AppException.notFound('File');
    const obj = await this.storage.get(res.payload.k);
    if (!obj) throw AppException.notFound('File');
    return obj;
  }

  revealId(user: AuthUser, id: string, ip?: string) {
    return this.db.tenant(user.tenantId, async (tx) => {
      const g = await this.load(tx, user.tenantId, id);
      await this.audit.record(tx, {
        tenantId: user.tenantId,
        actor: userActor(user),
        action: 'guest.id_revealed',
        entityType: 'guest',
        entityId: id,
        metadata: { fullName: g.fullName },
        ip,
      });
      return {
        idType: g.idType,
        idNumber: this.decryptIdNumber(g),
        idImageUrl: g.idImageKey ? this.fileUrl(user.tenantId, g.idImageKey) : null,
      };
    });
  }

  async uploadIdImage(user: AuthUser, id: string, file: UploadedFileLike | undefined, ip?: string) {
    if (!file) throw Err.validation('file', 'Attach the ID image as form field "file"');
    const ext = ALLOWED_TYPES[file.mimetype];
    if (!ext) throw Err.validation('file', 'Upload a JPEG, PNG, WebP or PDF');
    if (file.size > MAX_ID_IMAGE_BYTES) throw Err.validation('file', 'The file is larger than 5 MB');
    if (!sniff(file.buffer, file.mimetype)) throw Err.validation('file', 'The file content does not match its type');
    const key = `tenants/${user.tenantId}/guests/${id}/id-${randomUUID()}.${ext}`;
    const previous = await this.db.tenant(user.tenantId, async (tx) => {
      const g = await this.load(tx, user.tenantId, id);
      if (g.anonymisedAt) throw this.anonymised();
      return g.idImageKey;
    });
    await this.storage.put(key, file.buffer, file.mimetype);
    try {
      await this.db.tenant(user.tenantId, async (tx) => {
        await tx.guest.update({ where: { id }, data: { idImageKey: key, idImageContentType: file.mimetype } });
        await this.audit.record(tx, {
          tenantId: user.tenantId,
          actor: userActor(user),
          action: 'guest.id_image_uploaded',
          entityType: 'guest',
          entityId: id,
          metadata: { contentType: file.mimetype, bytes: file.size },
          ip,
        });
      });
    } catch (e) {
      await this.storage.delete(key).catch(() => undefined);
      throw e;
    }
    if (previous) await this.storage.delete(previous).catch(() => undefined);
    return { hasIdImage: true, idImageUrl: this.fileUrl(user.tenantId, key) };
  }

  async deleteIdImage(user: AuthUser, id: string, ip?: string) {
    const key = await this.db.tenant(user.tenantId, async (tx) => {
      const g = await this.load(tx, user.tenantId, id);
      await tx.guest.update({ where: { id }, data: { idImageKey: null, idImageContentType: null } });
      await this.audit.record(tx, {
        tenantId: user.tenantId,
        actor: userActor(user),
        action: 'guest.id_image_deleted',
        entityType: 'guest',
        entityId: id,
        ip,
      });
      return g.idImageKey;
    });
    if (key) await this.storage.delete(key).catch(() => undefined);
    return { success: true };
  }

  /** NDPA subject access: everything held about the guest, as JSON. */
  exportData(user: AuthUser, id: string, ip?: string) {
    return this.db.tenant(user.tenantId, async (tx) => {
      const g = await this.load(tx, user.tenantId, id);
      const reservations = await tx.reservation.findMany({
        where: { guestId: id },
        include: { room: true, roomType: true, folio: { include: { entries: true, invoices: true } } },
        orderBy: { arrivalAt: 'asc' },
      });
      await this.audit.record(tx, {
        tenantId: user.tenantId,
        actor: userActor(user),
        action: 'guest.exported',
        entityType: 'guest',
        entityId: id,
        metadata: { fullName: g.fullName, reservations: reservations.length },
        ip,
      });
      const stats = await this.stats(tx, [id]);
      return {
        exportedAt: new Date().toISOString(),
        guest: { ...this.toView(g, stats.get(id)), idNumber: this.decryptIdNumber(g) },
        reservations: reservations.map((r) => ({
          id: r.id,
          code: r.code,
          status: r.status,
          stayType: r.stayType,
          source: r.source,
          arrivalAt: r.arrivalAt.toISOString(),
          departureAt: r.departureAt.toISOString(),
          roomNumber: r.room?.number ?? null,
          roomType: r.roomType.name,
          adults: r.adults,
          children: r.children,
          rateKobo: Number(r.rateKobo),
          registration: {
            arrivingFrom: r.regArrivingFrom,
            goingTo: r.regGoingTo,
            purpose: r.regPurpose,
            vehiclePlate: r.regVehiclePlate,
            completedAt: r.registrationCompletedAt?.toISOString() ?? null,
          },
          checkedInAt: r.checkedInAt?.toISOString() ?? null,
          checkedOutAt: r.checkedOutAt?.toISOString() ?? null,
        })),
        folios: reservations
          .filter((r) => r.folio)
          .map((r) => ({
            id: r.folio!.id,
            entries: r.folio!.entries.map((e) => ({
              id: e.id,
              type: e.type,
              amountKobo: Number(e.amountKobo),
              description: e.description,
              businessDate: fromDbDate(e.businessDate),
              paymentMethod: e.paymentMethod,
              createdAt: e.createdAt.toISOString(),
            })),
          })),
        invoices: reservations.flatMap((r) =>
          (r.folio?.invoices ?? []).map((i) => ({ id: i.id, number: i.number, kind: i.kind, issuedAt: i.issuedAt.toISOString(), totalKobo: Number(i.totalKobo) })),
        ),
      };
    });
  }

  /** NDPA erasure: wipes PII, keeps the financial trail. Irreversible. */
  async anonymise(user: AuthUser, id: string, reason: string, ip?: string) {
    const { view, imageKey } = await this.db.tenant(user.tenantId, async (tx) => {
      const g = await this.load(tx, user.tenantId, id);
      if (g.anonymisedAt) throw this.anonymised();
      const active = await tx.reservation.count({ where: { guestId: id, status: 'CHECKED_IN' } });
      if (active) throw AppException.conflict('Check the guest out before anonymising their record');
      const updated = await tx.guest.update({
        where: { id },
        data: {
          fullName: 'Anonymised guest',
          phone: null,
          email: null,
          gender: null,
          dateOfBirth: null,
          address: null,
          idType: null,
          idNumberEnc: null,
          idNumberLast4: null,
          idImageKey: null,
          idImageContentType: null,
          vehiclePlate: null,
          company: null,
          vip: false,
          notes: '',
          marketingOptIn: false,
          anonymisedAt: new Date(),
        },
      });
      await tx.reservation.updateMany({
        where: { guestId: id },
        data: { regArrivingFrom: null, regGoingTo: null, regVehiclePlate: null, notes: '' },
      });
      await tx.folio.updateMany({ where: { guestId: id }, data: { name: 'Anonymised guest' } });
      await tx.folio.updateMany({ where: { reservation: { guestId: id } }, data: { name: 'Anonymised guest' } });
      await this.audit.record(tx, {
        tenantId: user.tenantId,
        actor: userActor(user),
        action: 'guest.anonymised',
        entityType: 'guest',
        entityId: id,
        metadata: { reason },
        ip,
      });
      return { view: this.toView(updated), imageKey: g.idImageKey };
    });
    if (imageKey) await this.storage.delete(imageKey).catch(() => undefined);
    return view;
  }

  /** Police / security register rows for stays checked in within [from, to]. */
  register(user: AuthUser, q: RegisterQueryDto, ip?: string) {
    if (!isIsoDate(q.from) || !isIsoDate(q.to) || q.to < q.from) throw Err.validation('to', 'Give a valid date range');
    if (diffDays(q.from, q.to) > 92) throw Err.validation('to', 'The range can be at most 92 days');
    const full = q.includeIdNumbers === 'true';
    if (full && !isManager(user.role)) throw AppException.forbidden('Only a manager can export full ID numbers');
    return this.db.tenant(user.tenantId, async (tx) => {
      const rows = await tx.reservation.findMany({
        where: {
          tenantId: user.tenantId,
          checkedInAt: { gte: lagosStartOfDay(q.from), lt: lagosStartOfDay(addDays(q.to, 1)) },
        },
        include: { guest: true, room: true },
        orderBy: { checkedInAt: 'asc' },
      });
      const names = new Map(
        (
          await tx.user.findMany({
            where: { id: { in: rows.map((r) => r.registrationCompletedById ?? r.checkedInById).filter((x): x is string => !!x) } },
            select: { id: true, fullName: true },
          })
        ).map((u) => [u.id, u.fullName]),
      );
      if (full) {
        await this.audit.record(tx, {
          tenantId: user.tenantId,
          actor: userActor(user),
          action: 'guest_register.exported_with_ids',
          entityType: 'guest_register',
          metadata: { from: q.from, to: q.to, rows: rows.length },
          ip,
        });
      }
      const items = rows.map((r) => ({
        checkedInAt: r.checkedInAt!.toISOString(),
        checkedOutAt: r.checkedOutAt?.toISOString() ?? null,
        roomNumber: r.room?.number ?? '',
        reservationCode: r.code,
        guestName: r.guest.fullName,
        phone: r.guest.phone,
        nationality: r.guest.nationality,
        gender: r.guest.gender,
        idType: r.guest.idType,
        idNumber: full ? this.decryptIdNumber(r.guest) : maskIdNumber(r.guest.idNumberLast4),
        address: r.guest.address,
        arrivingFrom: r.regArrivingFrom,
        goingTo: r.regGoingTo,
        purpose: r.regPurpose,
        vehiclePlate: r.regVehiclePlate ?? r.guest.vehiclePlate,
        company: r.guest.company,
        adults: r.adults,
        children: r.children,
        registeredBy: names.get(r.registrationCompletedById ?? r.checkedInById ?? '') ?? null,
      }));
      return { from: q.from, to: q.to, items };
    });
  }

  static toCsv(items: Record<string, unknown>[]): string {
    const esc = (v: unknown) => {
      if (v === null || v === undefined) return '';
      let s = typeof v === 'string' ? v : typeof v === 'number' || typeof v === 'boolean' ? String(v) : JSON.stringify(v);
      // Neutralise spreadsheet formula injection.
      if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
      return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    const lines = [REGISTER_COLUMNS.join(',')];
    for (const row of items) lines.push(REGISTER_COLUMNS.map((c) => esc(row[c])).join(','));
    return `${lines.join('\r\n')}\r\n`;
  }
}

/** Minimal magic-number check so a renamed file cannot pose as an image. */
function sniff(buf: Buffer, mime: string): boolean {
  if (buf.length < 4) return false;
  switch (mime) {
    case 'image/jpeg':
      return buf[0] === 0xff && buf[1] === 0xd8;
    case 'image/png':
      return buf.subarray(0, 4).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    case 'image/webp':
      return buf.subarray(0, 4).toString('ascii') === 'RIFF' && buf.subarray(8, 12).toString('ascii') === 'WEBP';
    case 'application/pdf':
      return buf.subarray(0, 4).toString('ascii') === '%PDF';
    default:
      return false;
  }
}
