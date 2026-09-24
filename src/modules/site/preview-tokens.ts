import { HttpStatus, Injectable } from '@nestjs/common';
import { signToken, verifyToken } from '../../common/crypto/signed-token.js';
import { AppException } from '../../common/errors/app-exception.js';
import { AppConfigService } from '../../config/app-config.service.js';

export type PreviewKind = 'THEME' | 'FORM';

interface PreviewPayload {
  tid: string;
  /** Property id, or null for the group root. */
  pid: string | null;
  k: PreviewKind[];
  exp: number;
}

export interface PreviewGrant {
  tenantId: string;
  propertyId: string | null;
  kinds: PreviewKind[];
  expiresAt: Date;
}

/**
 * Short-lived signed links that let the web app render a hotel's DRAFT theme
 * and booking form (Brand Studio live preview). Stateless HMAC tokens with
 * their own purpose string, so they can never be replayed as anything else.
 */
@Injectable()
export class PreviewTokens {
  constructor(private readonly config: AppConfigService) {}

  private get secret() {
    return this.config.get('SHARE_TOKEN_SECRET');
  }

  sign(tenantId: string, propertyId: string | null, kinds: PreviewKind[], ttlMinutes: number, now = new Date()): { token: string; expiresAt: Date } {
    const expiresAt = new Date(now.getTime() + ttlMinutes * 60_000);
    const token = signToken<PreviewPayload>(this.secret, 'site-preview', { tid: tenantId, pid: propertyId, k: kinds, exp: Math.floor(expiresAt.getTime() / 1000) });
    return { token, expiresAt };
  }

  /** 404 for a bad token, 410 PREVIEW_EXPIRED for an old one. */
  verify(token: string, kind: PreviewKind): PreviewGrant {
    const res = verifyToken<PreviewPayload>(this.secret, 'site-preview', token);
    if (!res.ok) {
      if (res.reason === 'expired') {
        let expiredAt: string | null = null;
        try {
          expiredAt = new Date((JSON.parse(Buffer.from(token.split('.')[0]!, 'base64url').toString('utf8')) as PreviewPayload).exp * 1000).toISOString();
        } catch {
          expiredAt = null;
        }
        throw new AppException(HttpStatus.GONE, 'PREVIEW_EXPIRED', 'This preview link has expired. Open a new preview from the Brand Studio.', { expiredAt });
      }
      throw AppException.notFound('Preview');
    }
    if (!res.payload.k.includes(kind)) throw AppException.notFound('Preview');
    return { tenantId: res.payload.tid, propertyId: res.payload.pid, kinds: res.payload.k, expiresAt: new Date(res.payload.exp * 1000) };
  }
}
