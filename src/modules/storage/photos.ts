import { randomUUID } from 'node:crypto';
import { Err } from '../ops/ops.helpers.js';
import { sniff, type UploadedFileLike } from '../guests/guests.service.js';
import type { ObjectStorage } from './object-storage.js';

export const MAX_PHOTO_BYTES = 5 * 1024 * 1024;
const TYPES: Record<string, string> = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' };

export interface StoredPhoto {
  key: string;
  uploadedAt: string;
}

/**
 * Stores an issue / task / lost-and-found photo under the tenant's prefix
 * (checked by type, size and file signature). Served through the signed
 * `/files/:token` URLs like ID images.
 */
export async function storePhoto(storage: ObjectStorage, tenantId: string, folder: string, file: UploadedFileLike | undefined): Promise<StoredPhoto> {
  if (!file) throw Err.validation('file', 'Attach the photo as form field "file"');
  const ext = TYPES[file.mimetype];
  if (!ext) throw Err.validation('file', 'Photos must be JPEG, PNG or WebP');
  if (file.size > MAX_PHOTO_BYTES) throw Err.validation('file', 'Photos can be at most 5 MB');
  if (!sniff(file.buffer, file.mimetype)) throw Err.validation('file', 'The file content does not match its type');
  const key = `tenants/${tenantId}/${folder}/${randomUUID()}.${ext}`;
  await storage.put(key, file.buffer, file.mimetype);
  return { key, uploadedAt: new Date().toISOString() };
}

export function photosOf(v: unknown): StoredPhoto[] {
  return Array.isArray(v) ? (v as StoredPhoto[]).filter((p) => p && typeof p.key === 'string') : [];
}
