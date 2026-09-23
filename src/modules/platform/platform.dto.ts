import { Transform, Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsDateString,
  IsEnum,
  IsIn,
  IsInt,
  IsNotEmpty,
  IsObject,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  ValidateIf,
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
