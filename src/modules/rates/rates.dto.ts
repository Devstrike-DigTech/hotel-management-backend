import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  Max,
  MaxLength,
  Min,
  MinLength,
  ValidateNested,
} from 'class-validator';

const CHANNELS = ['FRONT_DESK', 'BOOKING_SITE', 'MARKETPLACE'] as const;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

export class AdjustmentDto {
  @IsIn(['PERCENT', 'AMOUNT', 'FIXED']) type!: 'PERCENT' | 'AMOUNT' | 'FIXED';
  @IsInt() @Min(-100_000_000) @Max(100_000_000) value!: number;
}

export class FixedPriceDto {
  @IsUUID() roomTypeId!: string;
  @IsInt() @Min(0) @Max(100_000_000_00) rateKobo!: number;
}

export class CancelPolicyDto {
  @IsBoolean() nonRefundable!: boolean;
  @IsInt() @Min(0) @Max(720) freeCancellationHours!: number;
  @IsInt() @Min(0) @Max(100) lateCancellationFeePct!: number;
}

export class RatePlanDto {
  @IsString() @Matches(/^[A-Za-z0-9_]{2,12}$/, { message: 'code is 2 to 12 letters, digits or _' }) code!: string;
  @IsString() @MinLength(2) @MaxLength(80) name!: string;
  @IsOptional() @IsString() @MaxLength(500) description?: string;
  @IsIn(['BAR', 'NON_REFUNDABLE', 'CORPORATE', 'LONG_STAY', 'PACKAGE']) kind!: 'BAR' | 'NON_REFUNDABLE' | 'CORPORATE' | 'LONG_STAY' | 'PACKAGE';
  @IsIn(['DERIVED', 'FIXED']) pricing!: 'DERIVED' | 'FIXED';
  @IsOptional() @ValidateNested() @Type(() => AdjustmentDto) adjustment?: AdjustmentDto | null;
  @IsOptional() @IsArray() @ArrayMaxSize(50) @ValidateNested({ each: true }) @Type(() => FixedPriceDto) fixedPrices?: FixedPriceDto[];
  @IsOptional() @ValidateNested() @Type(() => CancelPolicyDto) cancellationPolicy?: CancelPolicyDto | null;
  @IsOptional() @IsInt() @Min(1) @Max(365) minNights?: number | null;
  @IsOptional() @IsInt() @Min(1) @Max(365) maxNights?: number | null;
  @IsOptional() @IsBoolean() includesBreakfast?: boolean;
  @IsOptional() @IsArray() @IsIn(CHANNELS, { each: true }) channels?: string[];
  @IsOptional() @IsArray() @IsUUID('all', { each: true }) roomTypeIds?: string[];
  @IsOptional() @IsBoolean() active?: boolean;
  @IsOptional() @IsInt() @Min(0) @Max(1000) sortOrder?: number;
}

export class UpdateRatePlanDto {
  @IsOptional() @IsString() @Matches(/^[A-Za-z0-9_]{2,12}$/) code?: string;
  @IsOptional() @IsString() @MinLength(2) @MaxLength(80) name?: string;
  @IsOptional() @IsString() @MaxLength(500) description?: string;
  @IsOptional() @IsIn(['BAR', 'NON_REFUNDABLE', 'CORPORATE', 'LONG_STAY', 'PACKAGE']) kind?: 'BAR' | 'NON_REFUNDABLE' | 'CORPORATE' | 'LONG_STAY' | 'PACKAGE';
  @IsOptional() @IsIn(['DERIVED', 'FIXED']) pricing?: 'DERIVED' | 'FIXED';
  @IsOptional() @ValidateNested() @Type(() => AdjustmentDto) adjustment?: AdjustmentDto | null;
  @IsOptional() @IsArray() @ArrayMaxSize(50) @ValidateNested({ each: true }) @Type(() => FixedPriceDto) fixedPrices?: FixedPriceDto[];
  @IsOptional() @ValidateNested() @Type(() => CancelPolicyDto) cancellationPolicy?: CancelPolicyDto | null;
  @IsOptional() @IsInt() @Min(1) @Max(365) minNights?: number | null;
  @IsOptional() @IsInt() @Min(1) @Max(365) maxNights?: number | null;
  @IsOptional() @IsBoolean() includesBreakfast?: boolean;
  @IsOptional() @IsArray() @IsIn(CHANNELS, { each: true }) channels?: string[];
  @IsOptional() @IsArray() @IsUUID('all', { each: true }) roomTypeIds?: string[];
  @IsOptional() @IsBoolean() active?: boolean;
  @IsOptional() @IsInt() @Min(0) @Max(1000) sortOrder?: number;
}

export class RateRuleDto {
  @IsString() @MinLength(2) @MaxLength(80) name!: string;
  @IsOptional() @IsArray() @IsUUID('all', { each: true }) roomTypeIds?: string[];
  @IsString() @Matches(DATE) dateFrom!: string;
  @IsString() @Matches(DATE) dateTo!: string;
  @IsOptional() @IsArray() @IsInt({ each: true }) daysOfWeek?: number[];
  @ValidateNested() @Type(() => AdjustmentDto) adjustment!: AdjustmentDto;
  @IsOptional() @IsInt() @Min(-1000) @Max(1000) priority?: number;
  @IsOptional() @IsIn(['laterite', 'brass', 'palm', 'adire', 'ochre']) color?: string;
  @IsOptional() @IsBoolean() active?: boolean;
}

export class UpdateRateRuleDto {
  @IsOptional() @IsString() @MinLength(2) @MaxLength(80) name?: string;
  @IsOptional() @IsArray() @IsUUID('all', { each: true }) roomTypeIds?: string[];
  @IsOptional() @IsString() @Matches(DATE) dateFrom?: string;
  @IsOptional() @IsString() @Matches(DATE) dateTo?: string;
  @IsOptional() @IsArray() @IsInt({ each: true }) daysOfWeek?: number[];
  @IsOptional() @ValidateNested() @Type(() => AdjustmentDto) adjustment?: AdjustmentDto;
  @IsOptional() @IsInt() @Min(-1000) @Max(1000) priority?: number;
  @IsOptional() @IsIn(['laterite', 'brass', 'palm', 'adire', 'ochre']) color?: string;
  @IsOptional() @IsBoolean() active?: boolean;
}

export class PutOverridesDto {
  @IsArray() @ArrayMaxSize(50) @IsUUID('all', { each: true }) roomTypeIds!: string[];
  @IsString() @Matches(DATE) from!: string;
  @IsString() @Matches(DATE) to!: string;
  @IsOptional() @IsArray() @IsInt({ each: true }) daysOfWeek?: number[];
  @IsOptional() @IsInt() @Min(0) @Max(100_000_000_00) rateKobo!: number | null;
  @IsOptional() @IsString() @MaxLength(200) note?: string;
}

export class PutRestrictionsDto {
  @IsOptional() @IsArray() @IsUUID('all', { each: true }) roomTypeIds?: string[] | null;
  @IsString() @Matches(DATE) from!: string;
  @IsString() @Matches(DATE) to!: string;
  @IsOptional() @IsArray() @IsInt({ each: true }) daysOfWeek?: number[];
  @IsOptional() @IsBoolean() closedToArrival?: boolean;
  @IsOptional() @IsBoolean() closedToDeparture?: boolean;
  @IsOptional() @IsBoolean() stopSell?: boolean;
  @IsOptional() @IsInt() @Min(1) @Max(60) minNights?: number | null;
}

export class RangeDto {
  @IsOptional() @IsString() @Matches(DATE) from?: string;
  @IsOptional() @IsString() @Matches(DATE) to?: string;
  @IsOptional() @IsString() active?: string;
  @IsOptional() @IsUUID() roomTypeId?: string;
  @IsOptional() @IsUUID() ratePlanId?: string;
}

export class DeskQuoteDto {
  @IsUUID() roomTypeId!: string;
  @IsString() @Matches(DATE) arrivalDate!: string;
  @IsString() @Matches(DATE) departureDate!: string;
  @IsOptional() @IsUUID() ratePlanId?: string;
  @IsOptional() @IsString() @MaxLength(30) promoCode?: string;
  @IsOptional() @IsUUID() corporateAccountId?: string;
  @IsOptional() @IsInt() @Min(1) @Max(10) adults?: number;
  @IsOptional() @IsInt() @Min(0) @Max(10) children?: number;
  @IsOptional() @IsIn(CHANNELS) channel?: 'FRONT_DESK' | 'BOOKING_SITE' | 'MARKETPLACE';
  @IsOptional() @IsString() @MaxLength(30) guestPhone?: string;
  @IsOptional() @IsUUID() excludeReservationId?: string;
}

export class PromoCodeDto {
  @IsString() @MinLength(3) @MaxLength(20) code!: string;
  @IsOptional() @IsString() @MaxLength(300) description?: string;
  @IsIn(['PERCENT', 'AMOUNT', 'FREE_NIGHT']) type!: 'PERCENT' | 'AMOUNT' | 'FREE_NIGHT';
  @IsInt() @Min(1) @Max(100_000_000_00) value!: number;
  @IsOptional() @IsString() @Matches(DATE) validFrom?: string | null;
  @IsOptional() @IsString() @Matches(DATE) validTo?: string | null;
  @IsOptional() @IsString() @Matches(DATE) stayFrom?: string | null;
  @IsOptional() @IsString() @Matches(DATE) stayTo?: string | null;
  @IsOptional() @IsInt() @Min(1) @Max(60) minNights?: number | null;
  @IsOptional() @IsInt() @Min(1) @Max(1_000_000) maxUses?: number | null;
  @IsOptional() @IsInt() @Min(1) @Max(100) perGuestLimit?: number | null;
  @IsOptional() @IsArray() @IsIn(CHANNELS, { each: true }) channels?: string[];
  @IsOptional() @IsArray() @IsUUID('all', { each: true }) roomTypeIds?: string[];
  @IsOptional() @IsBoolean() firstBookingOnly?: boolean;
  @IsOptional() @IsBoolean() active?: boolean;
}

export class UpdatePromoCodeDto {
  @IsOptional() @IsString() @MinLength(3) @MaxLength(20) code?: string;
  @IsOptional() @IsString() @MaxLength(300) description?: string;
  @IsOptional() @IsIn(['PERCENT', 'AMOUNT', 'FREE_NIGHT']) type?: 'PERCENT' | 'AMOUNT' | 'FREE_NIGHT';
  @IsOptional() @IsInt() @Min(1) @Max(100_000_000_00) value?: number;
  @IsOptional() @IsString() @Matches(DATE) validFrom?: string | null;
  @IsOptional() @IsString() @Matches(DATE) validTo?: string | null;
  @IsOptional() @IsString() @Matches(DATE) stayFrom?: string | null;
  @IsOptional() @IsString() @Matches(DATE) stayTo?: string | null;
  @IsOptional() @IsInt() @Min(1) @Max(60) minNights?: number | null;
  @IsOptional() @IsInt() @Min(1) @Max(1_000_000) maxUses?: number | null;
  @IsOptional() @IsInt() @Min(1) @Max(100) perGuestLimit?: number | null;
  @IsOptional() @IsArray() @IsIn(CHANNELS, { each: true }) channels?: string[];
  @IsOptional() @IsArray() @IsUUID('all', { each: true }) roomTypeIds?: string[];
  @IsOptional() @IsBoolean() firstBookingOnly?: boolean;
  @IsOptional() @IsBoolean() active?: boolean;
}

export class PromoCheckDto {
  @IsString() @MaxLength(30) code!: string;
  @IsUUID() roomTypeId!: string;
  @IsString() @Matches(DATE) arrivalDate!: string;
  @IsString() @Matches(DATE) departureDate!: string;
  @IsOptional() @IsIn(CHANNELS) channel?: 'FRONT_DESK' | 'BOOKING_SITE' | 'MARKETPLACE';
  @IsOptional() @IsUUID() ratePlanId?: string;
  @IsOptional() @IsString() @MaxLength(30) guestPhone?: string;
}

export class PromoListDto {
  @IsOptional() @IsString() @MaxLength(20) status?: string;
  @IsOptional() @IsString() @MaxLength(40) q?: string;
}
