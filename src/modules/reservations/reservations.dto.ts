import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsISO8601,
  IsOptional,
  IsString,
  IsUUID,
  Length,
  Matches,
  Max,
  MaxLength,
  Min,
  ValidateIf,
  ValidateNested,
} from 'class-validator';
import { PaginationQueryDto } from '../../common/utils/pagination.dto.js';
import { GuestInputDto, GuestUpdateDto, PURPOSES } from '../guests/guests.dto.js';
import { MAX_AMOUNT_KOBO } from '../ops/ops.helpers.js';

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
export const SOURCES = ['WALK_IN', 'PHONE', 'WHATSAPP', 'MARKETPLACE', 'BOOKING_SITE', 'CORPORATE', 'OTA'] as const;
const METHODS = ['CASH', 'TRANSFER', 'POS', 'CARD_ONLINE', 'COMPLIMENTARY', 'CITY_LEDGER'] as const;

export class NightPriceDto {
  @Matches(DATE_RE) date!: string;
  @IsInt() @Min(0) @Max(MAX_AMOUNT_KOBO) rateKobo!: number;
}

export class CreateReservationDto {
  @IsOptional() @IsUUID() guestId?: string;
  @IsOptional() @ValidateNested() @Type(() => GuestInputDto) guest?: GuestInputDto;
  @IsUUID() roomTypeId!: string;
  @IsOptional() @IsUUID() roomId?: string;
  @IsOptional() @IsIn(['NIGHTLY', 'DAY_USE']) stayType?: 'NIGHTLY' | 'DAY_USE';
  @IsOptional() @Matches(DATE_RE) arrivalDate?: string;
  @IsOptional() @Matches(DATE_RE) departureDate?: string;
  @IsOptional() @IsISO8601() arrivalAt?: string;
  @IsOptional() @IsISO8601() departureAt?: string;
  @IsOptional() @IsInt() @Min(1) @Max(10) adults?: number;
  @IsOptional() @IsInt() @Min(0) @Max(10) children?: number;
  @IsOptional() @IsIn(SOURCES) source?: (typeof SOURCES)[number];
  @IsOptional() @IsIn(['PENDING', 'CONFIRMED']) status?: 'PENDING' | 'CONFIRMED';
  @IsOptional() @IsInt() @Min(0) @Max(MAX_AMOUNT_KOBO) rateKobo?: number;
  @IsOptional() @IsString() @MaxLength(1000) notes?: string;
  @IsOptional() @IsISO8601() clientCreatedAt?: string;
  /** M4 */
  @IsOptional() @IsUUID() ratePlanId?: string;
  @IsOptional() @IsString() @MaxLength(30) promoCode?: string;
  @IsOptional() @IsUUID() corporateAccountId?: string;
  @IsOptional() @IsArray() @ArrayMaxSize(60) @ValidateNested({ each: true }) @Type(() => NightPriceDto) nightlyRates?: NightPriceDto[];
}

export class UpdateReservationDto {
  @IsOptional() @Matches(DATE_RE) arrivalDate?: string;
  @IsOptional() @Matches(DATE_RE) departureDate?: string;
  @IsOptional() @IsISO8601() arrivalAt?: string;
  @IsOptional() @IsISO8601() departureAt?: string;
  @IsOptional() @IsUUID() roomTypeId?: string;
  @IsOptional() @ValidateIf((_o, v) => v !== null) @IsUUID() roomId?: string | null;
  @IsOptional() @IsInt() @Min(1) @Max(10) adults?: number;
  @IsOptional() @IsInt() @Min(0) @Max(10) children?: number;
  @IsOptional() @IsIn(SOURCES) source?: (typeof SOURCES)[number];
  @IsOptional() @IsString() @MaxLength(1000) notes?: string;
  @IsOptional() @IsInt() @Min(0) @Max(MAX_AMOUNT_KOBO) rateKobo?: number;
  /** M4 */
  @IsOptional() @IsUUID() ratePlanId?: string;
  @IsOptional() @ValidateIf((_o, v) => v !== null) @IsString() @MaxLength(30) promoCode?: string | null;
  @IsOptional() @ValidateIf((_o, v) => v !== null) @IsUUID() corporateAccountId?: string | null;
  @IsOptional() @IsArray() @ArrayMaxSize(60) @ValidateNested({ each: true }) @Type(() => NightPriceDto) nightlyRates?: NightPriceDto[];
}

export class ReservationQueryDto extends PaginationQueryDto {
  @IsOptional() @IsString() @MaxLength(120) status?: string;
  @IsOptional() @Matches(DATE_RE) from?: string;
  @IsOptional() @Matches(DATE_RE) to?: string;
  @IsOptional() @IsString() @MaxLength(80) q?: string;
  @IsOptional() @IsUUID() roomId?: string;
  @IsOptional() @IsUUID() roomTypeId?: string;
  @IsOptional() @IsUUID() guestId?: string;
  @IsOptional() @IsIn(['NIGHTLY', 'DAY_USE']) stayType?: 'NIGHTLY' | 'DAY_USE';
  @IsOptional() @IsIn(SOURCES) source?: (typeof SOURCES)[number];
}

export class RegistrationDto {
  @IsString() @Length(2, 120) arrivingFrom!: string;
  @IsString() @Length(2, 120) goingTo!: string;
  @IsIn(PURPOSES) purpose!: (typeof PURPOSES)[number];
  @IsOptional() @IsString() @MaxLength(20) vehiclePlate?: string;
}

export class PutRegistrationDto extends RegistrationDto {
  @IsOptional() @ValidateNested() @Type(() => GuestUpdateDto) guest?: GuestUpdateDto;
}

export class DepositDto {
  @IsInt() @Min(1) @Max(MAX_AMOUNT_KOBO) amountKobo!: number;
  @IsIn(METHODS) method!: (typeof METHODS)[number];
  @IsOptional() @IsString() @MaxLength(120) reference?: string;
}

export class OverrideDto {
  @IsString() @Length(3, 300) reason!: string;
}

export class CheckInDto {
  @IsOptional() @IsUUID() roomId?: string;
  @IsOptional() @ValidateNested() @Type(() => GuestUpdateDto) guest?: GuestUpdateDto;
  @IsOptional() @ValidateNested() @Type(() => RegistrationDto) registration?: RegistrationDto;
  @IsOptional() @IsBoolean() registerLater?: boolean;
  @IsOptional() @ValidateNested() @Type(() => DepositDto) deposit?: DepositDto;
  @IsOptional() @ValidateNested() @Type(() => OverrideDto) override?: OverrideDto;
  @IsOptional() @IsISO8601() clientCreatedAt?: string;
}

export class CheckOutDto {
  @IsOptional() @ValidateNested() @Type(() => OverrideDto) override?: OverrideDto;
  /** M4: charge the balance to the linked corporate account's City Ledger. */
  @IsOptional() @IsBoolean() cityLedger?: boolean;
  @IsOptional() @IsISO8601() clientCreatedAt?: string;
}

export class MoveRoomDto {
  @IsUUID() roomId!: string;
  @IsOptional() @IsString() @MaxLength(300) reason?: string;
}

export class ConvertToNightlyDto {
  @IsOptional() @Matches(DATE_RE) departureDate?: string;
}

export class CancelDto {
  @IsString() @Length(3, 300) reason!: string;
  @IsOptional() @IsInt() @Min(0) @Max(MAX_AMOUNT_KOBO) feeKobo?: number;
}

export class NoShowDto {
  @IsOptional() @IsString() @MaxLength(300) reason?: string;
  @IsOptional() @IsInt() @Min(0) @Max(MAX_AMOUNT_KOBO) feeKobo?: number;
}

export class AvailabilityQueryDto {
  @Matches(DATE_RE) from!: string;
  @Matches(DATE_RE) to!: string;
  @IsOptional() @IsUUID() roomTypeId?: string;
}

export class RoomsAvailabilityQueryDto {
  @IsUUID() roomTypeId!: string;
  @IsOptional() @IsIn(['NIGHTLY', 'DAY_USE']) stayType?: 'NIGHTLY' | 'DAY_USE';
  @IsOptional() @Matches(DATE_RE) arrivalDate?: string;
  @IsOptional() @Matches(DATE_RE) departureDate?: string;
  @IsOptional() @IsISO8601() arrivalAt?: string;
  @IsOptional() @IsISO8601() departureAt?: string;
  @IsOptional() @IsUUID() excludeReservationId?: string;
  /** "true": the window starts now; rooms with a guest still checked in are not free. */
  @IsOptional() @IsIn(['true', 'false']) forCheckIn?: 'true' | 'false';
}

export class TapeChartQueryDto {
  @Matches(DATE_RE) from!: string;
  @Matches(DATE_RE) to!: string;
}
