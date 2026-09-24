import { HttpStatus, Inject, Injectable, Logger } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { FormUpload } from '../../generated/prisma/client.js';
import { signToken, verifyToken } from '../../common/crypto/signed-token.js';
import { AppException } from '../../common/errors/app-exception.js';
import { ImageRejected, sanitizeImage, sniffImage } from '../../common/utils/image-sanitize.js';
import { AppConfigService } from '../../config/app-config.service.js';
import { DbService, type Tx } from '../../prisma/db.service.js';
import { GuestsService } from '../guests/guests.service.js';
import { Err } from '../ops/ops.helpers.js';
import { PlatformJobsService } from '../platform/console/platform-jobs.service.js';
import { OBJECT_STORAGE, type ObjectStorage } from '../storage/object-storage.js';
import type { FormField } from './form.catalogue.js';
import { DEFAULT_FILE_MB, FILE_TYPES, type ValidationIssue } from './form.logic.js';

export const FILE_SCANNER = Symbol('FILE_SCANNER');

/** Virus-scan hook for uploaded files. Plug a real engine (ClamAV, a cloud scanner) behind it in production. */
export interface FileScanner {
  readonly engine: string;
  scan(body: Buffer, contentType: string): Promise<{ clean: boolean; reason?: string }>;
}

/** Development / default: accepts everything, but still refuses the EICAR test string so the hook is testable. */
export class NoopFileScanner implements FileScanner {
  readonly engine = 'noop';
  async scan(body: Buffer): Promise<{ clean: boolean; reason?: string }> {
    const eicar = 'EICAR-STANDARD-ANTIVIRUS-TEST-FILE';
    return body.includes(Buffer.from(eicar)) ? { clean: false, reason: 'EICAR test signature' } : { clean: true };
  }
}

interface UploadTokenPayload {
  u: string;
  tid: string;
  pid: string;
  fk: string;
  exp: number;
}

const TEMP_HOURS = 24;
const CONTENT_TYPES: Record<(typeof FILE_TYPES)[number], string> = { pdf: 'application/pdf', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp' };
const EXT: Record<string, string> = { 'application/pdf': 'pdf', 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' };

export interface StoredFileAnswer {
  uploadId: string;
  name: string;
  contentType: string;
  size: number;
}

/**
 * FILE answers of the booking form (M7, feature `form_file_uploads`): sniffed
 * type, size cap per field, image metadata stripped, a virus-scan hook,
 * private storage, a signed upload token for the booking, temporary until a
 * booking attaches the file, then kept with the reservation.
 */
@Injectable()
export class FormUploadsService {
  private readonly logger = new Logger(FormUploadsService.name);

  constructor(
    private readonly db: DbService,
    private readonly config: AppConfigService,
    private readonly guests: GuestsService,
    @Inject(OBJECT_STORAGE) private readonly storage: ObjectStorage,
    @Inject(FILE_SCANNER) private readonly scanner: FileScanner,
  ) {
    PlatformJobsService.register('form-uploads-cleanup', async (refs) => refs.get(FormUploadsService, { strict: false }).cleanup());
  }

  private get secret() {
    return this.config.get('SHARE_TOKEN_SECRET');
  }

  /** Detects the real type from the bytes (the declared type and name are ignored). */
  static sniff(buf: Buffer): (typeof FILE_TYPES)[number] | null {
    if (buf.length >= 5 && buf.subarray(0, 5).toString('ascii') === '%PDF-') return 'pdf';
    const img = sniffImage(buf);
    if (img === 'png' || img === 'jpeg' || img === 'webp') return img;
    return null;
  }

  /** Stores an upload for a FILE field (the caller checked the field exists on the form). */
  async store(tx: Tx, tenantId: string, propertyId: string, f: FormField, file: { buffer: Buffer; size: number; originalname?: string } | undefined) {
    if (!file?.buffer?.length) throw Err.validation('file', 'Attach the file as form field "file"');
    const maxMb = f.validation?.maxFileMB ?? DEFAULT_FILE_MB;
    if (file.buffer.length > maxMb * 1024 * 1024) throw Err.validation('file', `${f.label}: files can be at most ${maxMb} MB`);
    const kind = FormUploadsService.sniff(file.buffer);
    const accept = (f.validation?.accept ?? [...FILE_TYPES]) as (typeof FILE_TYPES)[number][];
    if (!kind || !accept.includes(kind)) throw Err.validation('file', `${f.label}: upload ${accept.map((a) => a.toUpperCase()).join(', ')}`);
    let body = file.buffer;
    if (kind !== 'pdf') {
      try {
        body = sanitizeImage(file.buffer, { allowed: [kind], maxBytes: maxMb * 1024 * 1024, maxSide: 10_000, minSide: 1 }).body;
      } catch (e) {
        if (e instanceof ImageRejected) throw Err.validation('file', `${f.label}: ${e.message}`);
        throw e;
      }
    } else if (!file.buffer.subarray(Math.max(0, file.buffer.length - 1024)).toString('latin1').includes('%%EOF')) {
      throw Err.validation('file', `${f.label}: this PDF looks incomplete`);
    }
    const contentType = CONTENT_TYPES[kind];
    const scan = await this.scanner.scan(body, contentType);
    if (!scan.clean) {
      throw new AppException(HttpStatus.BAD_REQUEST, 'VALIDATION_ERROR', 'This file was refused by the virus scan', {
        fields: { file: ['This file was refused by the virus scan'] },
        issues: [{ path: 'file', fieldKey: f.key, code: 'FILE_INVALID', message: 'This file was refused by the virus scan' }],
      });
    }
    const id = randomUUID();
    const storageKey = `tenants/${tenantId}/form-uploads/${id}.${EXT[contentType]}`;
    await this.storage.put(storageKey, body, contentType);
    const name = (file.originalname ?? `upload.${EXT[contentType]}`).replace(/[^\w .()-]+/g, '_').slice(0, 120) || `upload.${EXT[contentType]}`;
    const expiresAt = new Date(Date.now() + TEMP_HOURS * 3_600_000);
    const row = await tx.formUpload.create({
      data: { id, tenantId, propertyId, fieldKey: f.key, storageKey, fileName: name, contentType, size: body.length, status: 'TEMP', scanEngine: this.scanner.engine, expiresAt },
    });
    const token = signToken<UploadTokenPayload>(this.secret, 'form-upload', { u: id, tid: tenantId, pid: propertyId, fk: f.key, exp: Math.floor(expiresAt.getTime() / 1000) });
    return { uploadId: row.id, token, fieldKey: f.key, name, contentType, size: row.size, expiresAt: expiresAt.toISOString() };
  }

  /** Checks a FILE answer `{ uploadId, token }` inside the booking transaction. */
  async check(tx: Tx, tenantId: string, propertyId: string, f: FormField, raw: unknown, path: string): Promise<{ value?: StoredFileAnswer; issues: ValidationIssue[] }> {
    const bad = (code: string, message: string) => ({ issues: [{ path, fieldKey: f.key, code, message }] });
    const v = (raw && typeof raw === 'object' ? raw : {}) as { uploadId?: unknown; token?: unknown };
    if (typeof v.uploadId !== 'string' || typeof v.token !== 'string') return bad('FILE_INVALID', `${f.label}: upload the file first`);
    const res = verifyToken<UploadTokenPayload>(this.secret, 'form-upload', v.token);
    if (!res.ok) return bad(res.reason === 'expired' ? 'FILE_EXPIRED' : 'FILE_INVALID', res.reason === 'expired' ? `${f.label}: the upload expired, please upload it again` : `${f.label}: upload the file again`);
    const p = res.payload;
    if (p.u !== v.uploadId || p.tid !== tenantId || p.pid !== propertyId || p.fk !== f.key) return bad('FILE_INVALID', `${f.label}: upload the file again`);
    const row = await tx.formUpload.findFirst({ where: { id: v.uploadId, tenantId, propertyId, fieldKey: f.key } });
    if (!row || row.status !== 'TEMP') return bad('FILE_INVALID', `${f.label}: upload the file again`);
    if (row.expiresAt < new Date()) return bad('FILE_EXPIRED', `${f.label}: the upload expired, please upload it again`);
    return { value: { uploadId: row.id, name: row.fileName, contentType: row.contentType, size: row.size }, issues: [] };
  }

  async attach(tx: Tx, tenantId: string, reservationId: string, uploadIds: string[]): Promise<void> {
    if (!uploadIds.length) return;
    await tx.formUpload.updateMany({ where: { tenantId, id: { in: uploadIds }, status: 'TEMP' }, data: { status: 'ATTACHED', reservationId, attachedAt: new Date() } });
  }

  /** Signed, 10-minute URL for staff (served by /files/:token like ID images). */
  url(u: Pick<FormUpload, 'tenantId' | 'storageKey'>): string {
    return this.guests.fileUrl(u.tenantId, u.storageKey);
  }

  /** NDPA anonymisation: deletes a reservation's files. */
  async deleteForReservations(tx: Tx, tenantId: string, reservationIds: string[]): Promise<string[]> {
    if (!reservationIds.length) return [];
    const rows = await tx.formUpload.findMany({ where: { tenantId, reservationId: { in: reservationIds }, status: { not: 'DELETED' } } });
    if (rows.length) await tx.formUpload.updateMany({ where: { id: { in: rows.map((r) => r.id) } }, data: { status: 'DELETED' } });
    return rows.map((r) => r.storageKey);
  }

  async deleteFiles(keys: string[]): Promise<void> {
    for (const k of keys) await this.storage.delete(k).catch(() => undefined);
  }

  /** Hourly: temporary uploads nobody booked with are deleted after 24 hours. */
  async cleanup(): Promise<{ deleted: number }> {
    const now = new Date();
    const rows = (
      await this.db.systemAll((tx, t) => tx.formUpload.findMany({ where: { ...t.tenants, status: 'TEMP', expiresAt: { lt: now } }, take: 500 }))
    ).flat();
    for (const r of rows) {
      await this.storage.delete(r.storageKey).catch(() => undefined);
      await this.db.systemFor(r.tenantId, (tx) => tx.formUpload.update({ where: { id: r.id }, data: { status: 'DELETED' } })).catch((e: Error) => this.logger.warn(`Upload cleanup ${r.id}: ${e.message}`));
    }
    return { deleted: rows.length };
  }
}
