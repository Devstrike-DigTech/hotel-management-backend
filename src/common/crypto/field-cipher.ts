import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
} from 'node:crypto';

const VERSION = 'v1';

/**
 * AES-256-GCM encryption for individual sensitive fields (guest ID numbers).
 *
 * The 256-bit key is SHA-256 of GUEST_DATA_KEY. Each value gets a random
 * 96-bit IV; the stored form is `v1:<iv>:<tag>:<ciphertext>` (base64url), so
 * the scheme can be rotated later by version prefix. The tag authenticates
 * the ciphertext and the tenant id (additional authenticated data), so a
 * value copied into another tenant's row does not decrypt.
 */
export class FieldCipher {
  private readonly key: Buffer;

  constructor(secret: string) {
    if (!secret || secret.length < 32) {
      throw new Error('GUEST_DATA_KEY must be at least 32 characters');
    }
    this.key = createHash('sha256').update(secret, 'utf8').digest();
  }

  encrypt(plain: string, aad: string): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.key, iv);
    cipher.setAAD(Buffer.from(aad, 'utf8'));
    const ct = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    return [VERSION, iv, tag, ct]
      .map((p) => (typeof p === 'string' ? p : p.toString('base64url')))
      .join(':');
  }

  decrypt(stored: string, aad: string): string {
    const [version, iv, tag, ct] = stored.split(':');
    if (version !== VERSION || !iv || !tag || ct === undefined) {
      throw new Error('Unsupported ciphertext format');
    }
    const decipher = createDecipheriv(
      'aes-256-gcm',
      this.key,
      Buffer.from(iv, 'base64url'),
    );
    decipher.setAAD(Buffer.from(aad, 'utf8'));
    decipher.setAuthTag(Buffer.from(tag, 'base64url'));
    return Buffer.concat([
      decipher.update(Buffer.from(ct, 'base64url')),
      decipher.final(),
    ]).toString('utf8');
  }
}

/** "••••••4821": six bullets and the last four characters. */
export function maskIdNumber(last4: string | null | undefined): string | null {
  if (!last4) return null;
  return `••••••${last4}`;
}

export function last4Of(value: string): string {
  const compact = value.replace(/\s+/g, '');
  return compact.slice(-4);
}
