import { Module } from '@nestjs/common';
import { APP_GUARD, APP_INTERCEPTOR } from '@nestjs/core';
import { JwtModule } from '@nestjs/jwt';
import { ThrottlerModule } from '@nestjs/throttler';
import { AuthGuard } from './common/guards/auth.guard.js';
import { PermissionGuard } from './common/guards/permission.guard.js';
import { PropertyScopeInterceptor } from './common/property-scope.interceptor.js';
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
import { GuestSideModule } from './modules/guest-side.module.js';
import { OperationsModule } from './modules/operations.module.js';
import { PlatformModule } from './modules/platform/platform.module.js';
import { PropertyModule } from './modules/property/property.module.js';
import { RatesModule } from './modules/rates/rates.module.js';
import { CorporateModule } from './modules/corporate/corporate.module.js';
import { MaintenanceModule } from './modules/maintenance/maintenance.module.js';
import { WhatsAppModule } from './modules/whatsapp/whatsapp.module.js';
import { StaffModule } from './modules/staff/staff.module.js';
import { PosModule } from './modules/pos/pos.module.js';
import { ChannelsModule } from './modules/channels/channels.module.js';
import { DynamicPricingModule } from './modules/pricing/pricing.module.js';
import { InboxModule } from './modules/inbox/inbox.module.js';
import { LoyaltyModule } from './modules/loyalty/loyalty.module.js';
import { DomainsModule } from './modules/domains/domains.module.js';
import { PrismaModule } from './prisma/prisma.module.js';
import { PlatformSecurityModule } from './modules/platform/security/platform-security.module.js';
import { DedicatedDbModule } from './modules/dedicated-db/dedicated-db.module.js';
import { PlatformPermissionGuard } from './modules/platform/security/platform-permission.guard.js';
import { PlatformAuditInterceptor } from './modules/platform/security/platform-audit.interceptor.js';

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
    PlatformSecurityModule,
    DedicatedDbModule,
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
    RatesModule,
    CorporateModule,
    MaintenanceModule,
    WhatsAppModule,
    PosModule,
    ChannelsModule,
    DynamicPricingModule,
    InboxModule,
    LoyaltyModule,
    DomainsModule,
    OperationsModule,
    GuestSideModule,
    BillingModule,
    PlatformModule,
    // BullMQ workers + the daily dunning schedule. Skipped when
    // JOBS_ENABLED=false (tests, scripts); decided before config validation
    // because module lists are static.
    ...(jobsEnabled() ? [JobsModule] : []),
  ],
  providers: [
    // Order matters: authenticate, then authorise by permission (re-reading
    // the staff member's role), then block writes on read-only
    // subscriptions, then check features and limits.
    { provide: APP_GUARD, useClass: AuthGuard },
    // M6: platform console permissions and step-up.
    { provide: APP_GUARD, useClass: PlatformPermissionGuard },
    { provide: APP_GUARD, useClass: PermissionGuard },
    { provide: APP_GUARD, useExisting: SubscriptionGuard },
    { provide: APP_GUARD, useExisting: FeatureGuard },
    { provide: APP_GUARD, useExisting: LimitGuard },
    // M5: every staff request runs in its property scope.
    { provide: APP_INTERCEPTOR, useClass: PropertyScopeInterceptor },
    // M6: every mutating platform request lands in the platform audit log.
    { provide: APP_INTERCEPTOR, useClass: PlatformAuditInterceptor },
  ],
})
export class AppModule {}
