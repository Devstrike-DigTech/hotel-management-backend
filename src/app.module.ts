import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { JwtModule } from '@nestjs/jwt';
import { ThrottlerModule } from '@nestjs/throttler';
import { AuthGuard } from './common/guards/auth.guard.js';
import { RolesGuard } from './common/guards/roles.guard.js';
import { AppConfigModule } from './config/config.module.js';
import { AppConfigService } from './config/app-config.service.js';
import { AuditModule } from './modules/audit/audit.module.js';
import { AuthModule } from './modules/auth/auth.module.js';
import {
  FeatureGuard,
  LimitGuard,
  SubscriptionGuard,
} from './modules/entitlements/entitlements.guards.js';
import { EntitlementsModule } from './modules/entitlements/entitlements.module.js';
import { HealthModule } from './modules/health/health.module.js';
import { MeModule } from './modules/me/me.module.js';
import { PublicModule } from './modules/public/public.module.js';
import { RoomTypesModule } from './modules/room-types/room-types.module.js';
import { RoomsModule } from './modules/rooms/rooms.module.js';
import { BillingModule } from './modules/billing/billing.module.js';
import { DashboardModule } from './modules/dashboard/dashboard.module.js';
import { JobsModule } from './modules/jobs/jobs.module.js';
import { OperationsModule } from './modules/operations.module.js';
import { PlatformModule } from './modules/platform/platform.module.js';
import { PropertyModule } from './modules/property/property.module.js';
import { StaffModule } from './modules/staff/staff.module.js';
import { PrismaModule } from './prisma/prisma.module.js';

function jobsEnabled(): boolean {
  const v = process.env.JOBS_ENABLED;
  return v === undefined || v === 'true' || v === '1';
}

@Module({
  imports: [
    AppConfigModule,
    PrismaModule,
    JwtModule.register({ global: true }),
    ThrottlerModule.forRootAsync({
      imports: [],
      inject: [AppConfigService],
      useFactory: (config: AppConfigService) => [
        { ttl: 60_000, limit: config.get('AUTH_RATE_LIMIT') },
      ],
    }),
    AuditModule,
    EntitlementsModule,
    HealthModule,
    PublicModule,
    AuthModule,
    MeModule,
    RoomTypesModule,
    RoomsModule,
    DashboardModule,
    PropertyModule,
    StaffModule,
    OperationsModule,
    BillingModule,
    PlatformModule,
    // BullMQ workers + the daily dunning schedule. Skipped when
    // JOBS_ENABLED=false (tests, scripts); decided before config validation
    // because module lists are static.
    ...(jobsEnabled() ? [JobsModule] : []),
  ],
  providers: [
    // Order matters: authenticate, then authorise by role, then block writes
    // on read-only subscriptions, then check features and limits.
    { provide: APP_GUARD, useClass: AuthGuard },
    { provide: APP_GUARD, useClass: RolesGuard },
    { provide: APP_GUARD, useExisting: SubscriptionGuard },
    { provide: APP_GUARD, useExisting: FeatureGuard },
    { provide: APP_GUARD, useExisting: LimitGuard },
  ],
})
export class AppModule {}
