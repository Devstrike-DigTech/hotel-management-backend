import { Transform, Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsDateString,
  IsEmail,
  IsEnum,
  IsIn,
  IsInt,
  IsNotEmpty,
  IsObject,
  IsOptional,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
  MinLength,
  ValidateIf,
  ValidateNested,
} from 'class-validator';
import { SubscriptionStatus } from '../../generated/prisma/enums.js';
import { FEATURE_CODES } from '../entitlements/entitlements.constants.js';
import { LoginDto } from '../auth/auth.dto.js';

export class PlatformLoginDto extends LoginDto {}

export class TenantListQueryDto {
  @IsOptional() @IsString() @MaxLength(120)
  @Transform(({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value))
  q?: string;

  @IsOptional() @IsString() @MaxLength(40)
  plan?: string;

  @IsOptional() @IsEnum(SubscriptionStatus)
  status?: SubscriptionStatus;

  @IsOptional() @IsString() @MaxLength(80)
  city?: string;

  @IsOptional() @IsIn(['SHARED', 'DEDICATED'])
  dbMode?: 'SHARED' | 'DEDICATED';

  @IsOptional() @IsIn(['name', 'created', 'mrr'])
  sort?: 'name' | 'created' | 'mrr';

  @IsOptional() @Type(() => Number) @IsInt() @Min(1)
  page?: number = 1;

  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(100)
  pageSize?: number = 20;
}

export class UpdateTenantSubscriptionDto {
  @IsOptional() @IsString() @IsNotEmpty() @MaxLength(40)
  planCode?: string;

  @IsOptional() @IsEnum(SubscriptionStatus)
  status?: SubscriptionStatus;

  @IsOptional() @ValidateIf((_o, v) => v !== null) @IsDateString()
  trialEndsAt?: string | null;

  @IsOptional() @IsIn(['MONTHLY', 'YEARLY'])
  interval?: 'MONTHLY' | 'YEARLY';

  @IsOptional() @ValidateIf((_o, v) => v !== null) @IsInt() @Min(0) @Max(2_000_000_000)
  customPriceKobo?: number | null;

  @IsOptional() @ValidateIf((_o, v) => v !== null) @IsDateString()
  contractStartAt?: string | null;

  @IsOptional() @ValidateIf((_o, v) => v !== null) @IsDateString()
  contractEndAt?: string | null;

  @IsOptional() @ValidateIf((_o, v) => v !== null) @IsString() @MaxLength(2000)
  contractNotes?: string | null;
}

export class TenantOwnerDto {
  @IsString() @MinLength(2) @MaxLength(120)
  fullName!: string;

  @IsEmail() @MaxLength(254)
  email!: string;

  @IsString() @Matches(/^\+?[0-9 ()-]{7,20}$/, { message: 'phone must be a valid phone number' })
  phone!: string;
}

export class CreateTenantDto {
  @IsString() @MinLength(2) @MaxLength(120)
  name!: string;

  @IsOptional() @Matches(/^[a-z0-9](?:[a-z0-9-]{1,48}[a-z0-9])$/, { message: 'slug must be lower-case letters, digits and dashes' })
  slug?: string;

  @IsString() @MinLength(2) @MaxLength(80)
  city!: string;

  @IsString() @MinLength(2) @MaxLength(80)
  state!: string;

  @IsObject() @ValidateNested() @Type(() => TenantOwnerDto)
  owner!: TenantOwnerDto;

  @IsOptional() @IsString() @MaxLength(40)
  planCode?: string;

  @IsOptional() @IsIn(['MONTHLY', 'YEARLY'])
  interval?: 'MONTHLY' | 'YEARLY';

  @IsOptional() @ValidateIf((_o, v) => v !== null) @IsInt() @Min(0) @Max(2_000_000_000)
  customPriceKobo?: number | null;

  @IsOptional() @IsDateString()
  contractStartAt?: string;

  @IsOptional() @IsDateString()
  contractEndAt?: string;

  @IsOptional() @IsString() @MaxLength(2000)
  contractNotes?: string;

  @IsOptional() @IsIn(['ACTIVE', 'TRIALING'])
  status?: 'ACTIVE' | 'TRIALING';

  @ValidateIf((o: CreateTenantDto) => o.status === 'TRIALING') @IsDateString()
  trialEndsAt?: string;

  @IsOptional() @IsString() @MinLength(2) @MaxLength(120)
  propertyName?: string;
}

export class ExtendTrialDto {
  @Type(() => Number) @IsInt() @Min(1) @Max(90)
  days!: number;

  @IsString() @MinLength(3) @MaxLength(500)
  reason!: string;
}

export class ReasonDto {
  @IsString() @MinLength(5) @MaxLength(500)
  reason!: string;
}

export class ApplyCouponDto {
  @IsString() @MinLength(3) @MaxLength(32)
  code!: string;
}

export class SetFeatureOverrideDto {
  @IsIn(FEATURE_CODES as unknown as string[])
  featureCode!: string;

  @IsBoolean()
  enabled!: boolean;

  @IsOptional() @IsString() @MaxLength(300)
  note?: string;
}

export class UpdatePlanDto {
  @IsOptional() @IsString() @IsNotEmpty() @MaxLength(60)
  name?: string;

  @IsOptional() @IsString() @MaxLength(300)
  tagline?: string;

  @IsOptional() @ValidateIf((_o, v) => v !== null) @IsInt() @Min(0) @Max(2_000_000_000)
  priceMonthlyKobo?: number | null;

  @IsOptional() @ValidateIf((_o, v) => v !== null) @IsInt() @Min(0) @Max(2_000_000_000)
  priceYearlyKobo?: number | null;

  /** Record<limitCode, number>; -1 = unlimited. Merged into existing limits. */
  @IsOptional() @IsObject()
  limits?: Record<string, number>;

  /** Replaces the plan's feature list. */
  @IsOptional() @IsArray() @ArrayMaxSize(100)
  @IsIn(FEATURE_CODES as unknown as string[], { each: true })
  features?: string[];

  @IsOptional() @ValidateIf((_o, v) => v !== null) @IsInt() @Min(0) @Max(10_000)
  commissionBps?: number | null;

  @IsOptional() @IsBoolean()
  highlighted?: boolean;
}

// ---------------------------------------------------------------------------
// M6: platform authentication
// ---------------------------------------------------------------------------

export class MfaTokenDto {
  @IsString() @IsNotEmpty() @MaxLength(2000)
  mfaToken!: string;
}

export class MfaCodeDto extends MfaTokenDto {
  @IsString() @Matches(/^\s*\d{3}\s?\d{3}\s*$/, { message: 'code must be the 6-digit code from your authenticator app' })
  code!: string;
}

export class MfaVerifyDto extends MfaTokenDto {
  @IsOptional() @IsString() @MaxLength(12)
  code?: string;

  @IsOptional() @IsString() @MaxLength(20)
  recoveryCode?: string;
}

export class StepUpDto {
  @IsOptional() @IsString() @MaxLength(12)
  code?: string;

  @IsOptional() @IsString() @MaxLength(20)
  recoveryCode?: string;
}

export class PlatformRefreshDto {
  @IsString() @IsNotEmpty() @MaxLength(200)
  refreshToken!: string;
}

export class ChangePasswordDto {
  @IsString() @IsNotEmpty() @MaxLength(200)
  currentPassword!: string;

  @IsString() @MinLength(10) @MaxLength(200)
  newPassword!: string;
}

export class IpAllowlistDto {
  @IsArray() @ArrayMaxSize(50) @IsString({ each: true }) @MaxLength(64, { each: true })
  cidrs!: string[];
}

export class AcceptInviteDto {
  @IsString() @IsNotEmpty() @MaxLength(200)
  token!: string;

  @IsString() @MinLength(10) @MaxLength(200)
  password!: string;

  @IsOptional() @IsString() @MinLength(2) @MaxLength(120)
  fullName?: string;
}

export class DevTotpQueryDto {
  @IsEmail()
  email!: string;
}
