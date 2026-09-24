import { HttpStatus, Inject, Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { SiteAsset } from '../../generated/prisma/client.js';
import type { AuthUser } from '../../common/auth-types.js';
import { AppException } from '../../common/errors/app-exception.js';
import { ImageRejected, sanitizeImage, type ImageKind } from '../../common/utils/image-sanitize.js';
import { AppConfigService } from '../../config/app-config.service.js';
import { DbService, type Tx } from '../../prisma/db.service.js';
import { AuditService, userActor } from '../audit/audit.service.js';
import { Err } from '../ops/ops.helpers.js';
import { OBJECT_STORAGE, type ObjectStorage } from '../storage/object-storage.js';

export type SiteAssetKind = 'logo' | 'favicon' | 'image';
export const ASSET_KINDS: SiteAssetKind[] = ['logo', 'favicon', 'image'];

/** Same rules as the M6 white-label uploads, plus section images. */
export const ASSET_RULES: Record<SiteAssetKind, { allowed: ImageKind[]; maxBytes: number; maxSide: number; minSide: number }> = {
  logo: { allowed: ['png', 'jpeg', 'webp'], maxBytes: 2 * 1024 * 1024, maxSide: 2048, minSide: 32 },
  favicon: { allowed: ['png', 'ico'], maxBytes: 256 * 1024, maxSide: 512, minSide: 16 },
  image: { allowed: ['png', 'jpeg', 'webp'], maxBytes: 5 * 1024 * 1024, maxSide: 4096, minSide: 200 },
};

const FILE_RE = /^(logo|favicon|image)-[0-9a-f-]{36}\.(png|jpg|webp|ico)$/;

/**
 * Brand Studio uploads (M7, every plan with `brand_kit`): type sniffed from
 * the bytes, size and dimensions checked, metadata stripped, stored through
 * the storage driver and served publicly by the API.
 */
@Injectable()
export class SiteAssetsService {
  constructor(
    private readonly db: DbService,
    private readonly audit: AuditService,
    private readonly config: AppConfigService,
    @Inject(OBJECT_STORAGE) private readonly storage: ObjectStorage,
  ) {}

  base(tenantId: string): string {
    return `${this.config.get('API_PUBLIC_URL').replace(/\/$/, '')}/api/v1/public/site-assets/${tenantId}/`;
  }

  url(a: Pick<SiteAsset, 'tenantId' | 'fileName'>): string {
    return `${this.base(a.tenantId)}${a.fileName}`;
  }

  view(a: SiteAsset, usedBy: ('DRAFT' | 'PUBLISHED')[] = []) {
    return {
      id: a.id,
      kind: a.kind as SiteAssetKind,
      url: this.url(a),
      contentType: a.contentType,
      width: a.width,
      height: a.height,
      bytes: a.bytes,
      strippedBytes: a.strippedBytes,
      originalName: a.originalName,
      createdAt: a.createdAt.toISOString(),
      usedBy,
    };
  }

  async upload(u: AuthUser, kind: string, file: { buffer: Buffer; size: number; originalname?: string } | undefined, ip?: string) {
    if (!ASSET_KINDS.includes(kind as SiteAssetKind)) throw Err.validation('kind', 'kind must be logo, favicon or image');
    if (!file?.buffer?.length) throw Err.validation('file', 'Attach the image as form field "file"');
    let img;
    try {
      img = sanitizeImage(file.buffer, ASSET_RULES[kind as SiteAssetKind]);
    } catch (e) {
      if (e instanceof ImageRejected) throw Err.validation('file', e.message);
      throw e;
    }
    const fileName = `${kind}-${randomUUID()}.${img.kind === 'jpeg' ? 'jpg' : img.kind}`;
    const storageKey = `tenants/${u.tenantId}/site/${fileName}`;
    await this.storage.put(storageKey, img.body, img.contentType);
    const row = await this.db.tenant(u.tenantId, async (tx) => {
      const a = await tx.siteAsset.create({
        data: {
          tenantId: u.tenantId,
          kind,
          storageKey,
          fileName,
          contentType: img.contentType,
          width: img.width,
          height: img.height,
          bytes: img.body.length,
          strippedBytes: img.stripped,
          originalName: file.originalname ? file.originalname.slice(0, 200) : null,
          createdById: u.userId,
        },
      });
      await this.audit.record(tx, {
        tenantId: u.tenantId, actor: userActor(u), action: 'site.asset_uploaded', entityType: 'site_asset', entityId: a.id,
        metadata: { kind, width: img.width, height: img.height, bytes: img.body.length, strippedBytes: img.stripped }, ip,
      });
      return a;
    });
    return this.view(row);
  }

  async list(u: AuthUser, kind?: string) {
    return this.db.tenant(u.tenantId, async (tx) => {
      const rows = await tx.siteAsset.findMany({ where: { tenantId: u.tenantId, ...(kind && { kind }) }, orderBy: { createdAt: 'desc' }, take: 200 });
      const used = await this.usage(tx, u.tenantId);
      return rows.map((a) => this.view(a, used.get(a.id) ?? []));
    });
  }

  /** assetId -> where the themes use it (draft / latest published). */
  async usage(tx: Tx, tenantId: string): Promise<Map<string, ('DRAFT' | 'PUBLISHED')[]>> {
    const themes = await tx.siteTheme.findMany({ where: { tenantId }, select: { draft: true, publishedVersionId: true } });
    const versions = await tx.siteThemeVersion.findMany({ where: { id: { in: themes.map((t) => t.publishedVersionId).filter((x): x is string => !!x) } }, select: { content: true } });
    const out = new Map<string, ('DRAFT' | 'PUBLISHED')[]>();
    const add = (content: unknown, where: 'DRAFT' | 'PUBLISHED') => {
      const c = (content ?? {}) as { brand?: { logoAssetId?: string | null; faviconAssetId?: string | null } };
      for (const id of [c.brand?.logoAssetId, c.brand?.faviconAssetId]) {
        if (!id) continue;
        const list = out.get(id) ?? [];
        if (!list.includes(where)) list.push(where);
        out.set(id, list);
      }
    };
    for (const t of themes) add(t.draft, 'DRAFT');
    for (const v of versions) add(v.content, 'PUBLISHED');
    return out;
  }

  async remove(u: AuthUser, id: string, ip?: string) {
    const key = await this.db.tenant(u.tenantId, async (tx) => {
      const a = await tx.siteAsset.findFirst({ where: { id, tenantId: u.tenantId } });
      if (!a) throw AppException.notFound('Asset');
      const usedBy = (await this.usage(tx, u.tenantId)).get(id) ?? [];
      if (usedBy.length) throw new AppException(HttpStatus.CONFLICT, 'ASSET_IN_USE', 'This image is used by your theme. Replace it first.', { assetId: id, usedBy });
      await tx.siteAsset.delete({ where: { id } });
      await this.audit.record(tx, { tenantId: u.tenantId, actor: userActor(u), action: 'site.asset_deleted', entityType: 'site_asset', entityId: id, metadata: { kind: a.kind }, ip });
      return a.storageKey;
    });
    await this.storage.delete(key).catch(() => undefined);
    return { success: true };
  }

  /** Asset rows by id (for theme validation and URL resolution). */
  async byIds(tx: Tx, tenantId: string, ids: string[]): Promise<Map<string, SiteAsset>> {
    const list = ids.filter(Boolean);
    if (!list.length) return new Map();
    const rows = await tx.siteAsset.findMany({ where: { tenantId, id: { in: list } } });
    return new Map(rows.map((r) => [r.id, r]));
  }

  /** GET /public/site-assets/:tenantId/:file */
  async read(tenantId: string, file: string) {
    if (!/^[0-9a-f-]{36}$/.test(tenantId) || !FILE_RE.test(file)) throw AppException.notFound('Image');
    const o = await this.storage.get(`tenants/${tenantId}/site/${file}`);
    if (!o) throw AppException.notFound('Image');
    return o;
  }
}
