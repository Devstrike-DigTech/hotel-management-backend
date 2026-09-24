import { Injectable } from '@nestjs/common';
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { AppConfigService } from '../../config/app-config.service.js';
import { FieldCipher } from './field-cipher.js';

/**
 * Key material for platform secrets at rest: PLATFORM_DATA_KEY, or (when it is
 * not set) a key derived from GUEST_DATA_KEY so existing installs keep working.
 */
export function platformKeyMaterial(env: { PLATFORM_DATA_KEY?: string; GUEST_DATA_KEY: string }): string {
  return env.PLATFORM_DATA_KEY ?? createHmac('sha256', env.GUEST_DATA_KEY).update('platform-data-key:v1').digest('hex');
}

/**
 * AES-256-GCM for platform secrets (TOTP secrets, dedicated database URLs,
 * SSO client secrets, webhook signing secrets). The `purpose` is bound as
 * associated data, so a value copied into another column or row does not
 * decrypt.
 */
export class SecretCipher {
  private readonly cipher: FieldCipher;

  constructor(material: string) {
    this.cipher = new FieldCipher(material);
  }

  seal(value: string, purpose: string): string {
    return this.cipher.encrypt(value, purpose);
  }

  open(stored: string, purpose: string): string {
    return this.cipher.decrypt(stored, purpose);
  }
}

@Injectable()
export class SecretBox extends SecretCipher {
  constructor(config: AppConfigService) {
    super(platformKeyMaterial({ PLATFORM_DATA_KEY: config.get('PLATFORM_DATA_KEY'), GUEST_DATA_KEY: config.get('GUEST_DATA_KEY') }));
  }
}

/** Hex SHA-256 (API key secrets, one-time codes). */
export function sha256Hex(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

/** Constant-time comparison of two hex / ASCII strings. */
export function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

const BASE62 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
const LOWER36 = 'abcdefghijklmnopqrstuvwxyz0123456789';

/** Uniform random string over an alphabet (rejection sampling, no modulo bias). */
export function randomString(length: number, alphabet: string = BASE62): string {
  const out: string[] = [];
  const max = Math.floor(256 / alphabet.length) * alphabet.length;
  while (out.length < length) {
    for (const b of randomBytes(length * 2)) {
      if (b < max) out.push(alphabet[b % alphabet.length]!);
      if (out.length === length) break;
    }
  }
  return out.join('');
}

export const randomLower36 = (length: number) => randomString(length, LOWER36);
