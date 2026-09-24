import { Global, Module } from '@nestjs/common';
import { SecretBox } from '../common/crypto/secret-box.js';
import { DbService } from './db.service.js';
import { PlatformPrismaService } from './platform-prisma.service.js';
import { PrismaService } from './prisma.service.js';
import { TenantDbRouter } from './tenant-db-router.js';

@Global()
@Module({
  providers: [PrismaService, PlatformPrismaService, TenantDbRouter, DbService, SecretBox],
  exports: [PrismaService, DbService, TenantDbRouter, SecretBox, PlatformPrismaService],
})
export class PrismaModule {}
