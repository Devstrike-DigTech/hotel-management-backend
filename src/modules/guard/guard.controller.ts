import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Patch, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { IsIn, IsOptional, IsString, Length, Matches, MaxLength } from 'class-validator';
import type { GuardFlag, Prisma, Reservation, Room } from '../../generated/prisma/client.js';
import type { GuardRule, GuardSeverity, GuardStatus } from '../../generated/prisma/enums.js';
import type { AuthUser } from '../../common/auth-types.js';
import { ClientIp, CurrentUser, RequirePermission } from '../../common/decorators/index.js';
import { AppException } from '../../common/errors/app-exception.js';
import { addDays, lagosStartOfDay } from '../../common/time/lagos.js';
import { PaginationQueryDto } from '../../common/utils/pagination.dto.js';
import { DbService } from '../../prisma/db.service.js';
import { AuditService, userActor } from '../audit/audit.service.js';
import { RequireFeature } from '../entitlements/entitlements.decorators.js';
import { Err, kOrNull, paginate } from '../ops/ops.helpers.js';
import { ruleEnabled, RULES } from './guard.logic.js';
import { GuardService } from './guard.service.js';

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export class FlagQueryDto extends PaginationQueryDto {
  @IsOptional() @IsString() @MaxLength(80) status?: string;
  @IsOptional() @IsIn(['LOW', 'MEDIUM', 'HIGH']) severity?: GuardSeverity;
  @IsOptional() @IsString() @MaxLength(40) rule?: string;
  @IsOptional() @Matches(DATE_RE) from?: string;
  @IsOptional() @Matches(DATE_RE) to?: string;
}

export class UpdateFlagDto {
  @IsIn(['ACKNOWLEDGED', 'RESOLVED', 'DISMISSED']) status!: 'ACKNOWLEDGED' | 'RESOLVED' | 'DISMISSED';
  @IsOptional() @IsString() @Length(2, 500) resolution?: string;
}

type FlagRow = GuardFlag & { room: Room | null; reservation: Reservation | null };

function toView(f: FlagRow) {
  return {
    id: f.id,
    rule: f.rule,
    severity: f.severity,
    status: f.status,
    title: f.title,
    detail: f.detail,
    amountKobo: kOrNull(f.amountKobo),
    room: f.room ? { id: f.room.id, number: f.room.number } : null,
    reservation: f.reservation ? { id: f.reservation.id, code: f.reservation.code } : null,
    shiftId: f.shiftId,
    user: f.userId ? { id: f.userId, fullName: f.userName ?? '' } : null,
    evidence: f.evidence as Record<string, unknown>,
    suggestion: f.suggestion,
    resolvedBy: f.resolvedById ? { id: f.resolvedById, fullName: f.resolvedByName ?? '' } : null,
    resolvedAt: f.resolvedAt?.toISOString() ?? null,
    resolution: f.resolution,
    createdAt: f.createdAt.toISOString(),
    updatedAt: f.updatedAt.toISOString(),
  };
}

const STATUSES: GuardStatus[] = ['OPEN', 'ACKNOWLEDGED', 'RESOLVED', 'DISMISSED'];

@ApiTags('Revenue Guard')
@ApiBearerAuth()
@RequireFeature('revenue_guard_basic')
@RequirePermission('guard.view')
@Controller('guard')
export class GuardController {
  constructor(
    private readonly db: DbService,
    private readonly guard: GuardService,
    private readonly audit: AuditService,
  ) {}

  @Get('flags')
  list(@CurrentUser() user: AuthUser, @Query() q: FlagQueryDto) {
    const pg = paginate(q.page, q.pageSize);
    const statuses = q.status?.split(',').filter((s): s is GuardStatus => STATUSES.includes(s as GuardStatus));
    return this.db.tenant(user.tenantId, async (tx) => {
      const where: Prisma.GuardFlagWhereInput = {
        tenantId: user.tenantId,
        ...(statuses?.length && { status: { in: statuses } }),
        ...(q.severity && { severity: q.severity }),
        ...(q.rule && { rule: q.rule as GuardRule }),
        ...((q.from || q.to) && {
          createdAt: {
            ...(q.from && { gte: lagosStartOfDay(q.from) }),
            ...(q.to && { lt: lagosStartOfDay(addDays(q.to, 1)) }),
          },
        }),
      };
      if (q.rule && !RULES.some((r) => r.rule === q.rule)) throw Err.validation('rule', 'Unknown rule');
      const rows = await tx.guardFlag.findMany({ where, include: { room: true, reservation: true }, orderBy: { createdAt: 'desc' }, skip: pg.skip, take: pg.take });
      const total = await tx.guardFlag.count({ where });
      return { items: rows.map(toView), total, page: pg.page, pageSize: pg.pageSize };
    });
  }

  @Get('flags/:id')
  get(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.db.tenant(user.tenantId, async (tx) => {
      const f = await tx.guardFlag.findFirst({ where: { id, tenantId: user.tenantId }, include: { room: true, reservation: true } });
      if (!f) throw AppException.notFound('Flag');
      return toView(f);
    });
  }

  @Patch('flags/:id')
  @RequirePermission('guard.resolve')
  update(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateFlagDto, @ClientIp() ip?: string) {
    if (dto.status !== 'ACKNOWLEDGED' && !dto.resolution) throw Err.validation('resolution', 'Say how the flag was resolved or why it is dismissed');
    return this.db.tenant(user.tenantId, async (tx) => {
      const f = await tx.guardFlag.findFirst({ where: { id, tenantId: user.tenantId } });
      if (!f) throw AppException.notFound('Flag');
      if (f.status === 'RESOLVED' || f.status === 'DISMISSED') throw Err.invalidState(f.status, ['OPEN', 'ACKNOWLEDGED'], 'This flag');
      const final = dto.status !== 'ACKNOWLEDGED';
      const updated = await tx.guardFlag.update({
        where: { id },
        data: {
          status: dto.status,
          ...(dto.resolution !== undefined && { resolution: dto.resolution }),
          ...(final && { resolvedById: user.userId, resolvedByName: user.fullName, resolvedAt: new Date() }),
        },
        include: { room: true, reservation: true },
      });
      await this.audit.record(tx, {
        tenantId: user.tenantId,
        actor: userActor(user),
        action: `guard_flag.${dto.status.toLowerCase()}`,
        entityType: 'guard_flag',
        entityId: id,
        metadata: { rule: f.rule, title: f.title, resolution: dto.resolution ?? null },
        ip,
      });
      return toView(updated);
    });
  }

  @Get('rules')
  rules(@CurrentUser() user: AuthUser) {
    return this.db.tenant(user.tenantId, async (tx) => {
      const features = await this.guard.features(tx, user.tenantId);
      return RULES.map((r) => ({ ...r, enabled: ruleEnabled(r.rule, features) }));
    });
  }

  @Get('summary')
  summary(@CurrentUser() user: AuthUser) {
    return this.db.tenant(user.tenantId, async (tx) => {
      const rows = await tx.guardFlag.groupBy({
        by: ['severity', 'rule'],
        where: { tenantId: user.tenantId, status: { in: ['OPEN', 'ACKNOWLEDGED'] } },
        _count: { _all: true },
      });
      const bySeverity: Record<GuardSeverity, number> = { LOW: 0, MEDIUM: 0, HIGH: 0 };
      const byRule: Partial<Record<GuardRule, number>> = {};
      let open = 0;
      for (const r of rows) {
        open += r._count._all;
        bySeverity[r.severity] += r._count._all;
        byRule[r.rule] = (byRule[r.rule] ?? 0) + r._count._all;
      }
      return { open, bySeverity, byRule };
    });
  }

  @Post('sweep')
  @HttpCode(200)
  @RequirePermission('guard.resolve')
  async sweep(@CurrentUser() user: AuthUser) {
    return { created: await this.guard.sweep(user.tenantId) };
  }
}
