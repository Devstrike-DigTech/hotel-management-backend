import type { Provider } from '@nestjs/common';
import { AppConfigService } from '../../config/app-config.service.js';
import { LocalDiskStorage } from './local-disk.storage.js';
import { OBJECT_STORAGE, type ObjectStorage } from './object-storage.js';
import { S3Storage } from './s3.storage.js';

export const objectStorageProvider: Provider = {
  provide: OBJECT_STORAGE,
  inject: [AppConfigService],
  useFactory: (config: AppConfigService): ObjectStorage =>
    config.get('STORAGE_DRIVER') === 's3'
      ? new S3Storage({
          bucket: config.get('S3_BUCKET')!,
          region: config.get('S3_REGION'),
          endpoint: config.get('S3_ENDPOINT'),
          accessKeyId: config.get('S3_ACCESS_KEY_ID')!,
          secretAccessKey: config.get('S3_SECRET_ACCESS_KEY')!,
          forcePathStyle: config.get('S3_FORCE_PATH_STYLE'),
        })
      : new LocalDiskStorage(config.get('STORAGE_LOCAL_DIR')),
};
