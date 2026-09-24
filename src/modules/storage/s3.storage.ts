import {
  DeleteObjectCommand,
  DeleteObjectsCommand,
  GetObjectCommand,
  ListObjectsV2Command,
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

  async deletePrefix(prefix: string): Promise<number> {
    if (!/^[a-zA-Z0-9_-]+\/[a-zA-Z0-9_-]+\/$/.test(prefix)) throw new Error(`Refusing to delete prefix ${prefix}`);
    let removed = 0;
    let token: string | undefined;
    do {
      const page = await this.client.send(new ListObjectsV2Command({ Bucket: this.opts.bucket, Prefix: prefix, ContinuationToken: token }));
      const keys = (page.Contents ?? []).map((o) => ({ Key: o.Key! })).filter((o) => o.Key);
      if (keys.length) {
        await this.client.send(new DeleteObjectsCommand({ Bucket: this.opts.bucket, Delete: { Objects: keys, Quiet: true } }));
        removed += keys.length;
      }
      token = page.IsTruncated ? page.NextContinuationToken : undefined;
    } while (token);
    return removed;
  }
}
