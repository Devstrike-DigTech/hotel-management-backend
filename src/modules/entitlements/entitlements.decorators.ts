import { SetMetadata } from '@nestjs/common';
import type { FeatureCode, LimitCode } from './entitlements.constants.js';

export const REQUIRE_FEATURE_KEY = 'entitlements:requireFeature';
export const CHECK_LIMIT_KEY = 'entitlements:checkLimit';

/** Route requires every listed feature; otherwise 403 FEATURE_LOCKED. */
export const RequireFeature = (...features: FeatureCode[]) =>
  SetMetadata(REQUIRE_FEATURE_KEY, features);

/**
 * Route creates one unit counted against `limit`; 403 LIMIT_REACHED when the
 * tenant is already at the maximum. Bulk operations additionally re-check the
 * exact count inside their transaction.
 */
export const CheckLimit = (limit: LimitCode) =>
  SetMetadata(CHECK_LIMIT_KEY, limit);
