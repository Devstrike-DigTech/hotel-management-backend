import { Controller, Get, HttpStatus } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Public } from '../../common/decorators/index.js';
import { AppException } from '../../common/errors/app-exception.js';
import { PrismaService } from '../../prisma/prisma.service.js';

@ApiTags('Health')
@Public()
@Controller('health')
export class HealthController {
  constructor(private readonly prisma: PrismaService) {}

  /** Liveness: the process is up. */
  @Get()
  health() {
    return { status: 'ok' };
  }

  /** Readiness: the database answers. */
  @Get('ready')
  async ready() {
    try {
      await this.prisma.$queryRaw`SELECT 1`;
    } catch {
      throw new AppException(
        HttpStatus.SERVICE_UNAVAILABLE,
        'NOT_READY',
        'Database unavailable',
      );
    }
    return { status: 'ok', database: 'up' };
  }
}
