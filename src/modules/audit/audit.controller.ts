import { Controller, Get, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import type { AuthUser } from '../../common/auth-types.js';
import { CurrentUser, Roles } from '../../common/decorators/index.js';
import { PaginationQueryDto } from '../../common/utils/pagination.dto.js';
import { AuditService } from './audit.service.js';

@ApiTags('Audit logs')
@ApiBearerAuth()
@Controller('audit-logs')
export class AuditController {
  constructor(private readonly audit: AuditService) {}

  @Get()
  @Roles('OWNER', 'MANAGER', 'ACCOUNTANT')
  list(@CurrentUser() user: AuthUser, @Query() q: PaginationQueryDto) {
    return this.audit.list(user.tenantId, q.page ?? 1, q.pageSize ?? 20);
  }
}
