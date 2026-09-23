import {
  DeleteObjectCommand,
  GetObjectCommand,
  NoSuchKey,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { assertSafeKey, type ObjectStorage, type StoredObject } from './object-storage.js';

export interface S3Options {
  bucket: string;
  region: string;
  endpoint?: string;
  accessKeyId: string;
  secretAccessKey: string;
  forcePathStyle: boolean;
}

/** S3-compatible adapter (AWS S3, Cloudflare R2, MinIO, DigitalOcean Spaces). */
export class S3Storage implements ObjectStorage {
  readonly driver = 's3' as const;
  private readonly client: S3Client;

  constructor(private readonly opts: S3Options) {
    this.client = new S3Client({
      region: opts.region,
      endpoint: opts.endpoint || undefined,
      forcePathStyle: opts.forcePathStyle,
      credentials: { accessKeyId: opts.accessKeyId, secretAccessKey: opts.secretAccessKey },
    });
  }

  async put(key: string, body: Buffer, contentType: string): Promise<void> {
    assertSafeKey(key);
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.opts.bucket,
        Key: key,
        Body: body,
        ContentType: contentType,
        ServerSideEncryption: this.opts.endpoint ? undefined : 'AES256',
      }),
    );
  }

  async get(key: string): Promise<StoredObject | null> {
    assertSafeKey(key);
    try {
      const out = await this.client.send(new GetObjectCommand({ Bucket: this.opts.bucket, Key: key }));
      if (!out.Body) return null;
      const bytes = await out.Body.transformToByteArray();
      return { body: Buffer.from(bytes), contentType: out.ContentType ?? null };
    } catch (e) {
      if (e instanceof NoSuchKey || (e as { name?: string }).name === 'NoSuchKey') return null;
      throw e;
    }
  }

  async delete(key: string): Promise<void> {
    assertSafeKey(key);
    await this.client.send(new DeleteObjectCommand({ Bucket: this.opts.bucket, Key: key }));
  }
}
