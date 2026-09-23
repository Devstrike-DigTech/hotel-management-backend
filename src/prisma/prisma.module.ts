import { Global, Module } from '@nestjs/common';
import { DbService } from './db.service.js';
import { PrismaService } from './prisma.service.js';

@Global()
@Module({
  providers: [PrismaService, DbService],
  exports: [PrismaService, DbService],
})
export class PrismaModule {}
