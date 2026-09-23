import { Global, Module } from '@nestjs/common';
import {
  FeatureGuard,
  LimitGuard,
  SubscriptionGuard,
} from './entitlements.guards.js';
import { EntitlementsService } from './entitlements.service.js';

@Global()
@Module({
  providers: [EntitlementsService, SubscriptionGuard, FeatureGuard, LimitGuard],
  exports: [EntitlementsService, SubscriptionGuard, FeatureGuard, LimitGuard],
})
export class EntitlementsModule {}
