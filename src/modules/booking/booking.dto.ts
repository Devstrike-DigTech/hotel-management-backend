import { Transform, Type } from 'class-transformer';
import {
  Equals,
  IsBoolean,
  IsEmail,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Length,
  Matches,
  Max,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';
import { PaginationQueryDto } from '../../common/utils/pagination.dto.js';

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;
const trim = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value);

export const CHANNELS = ['MARKETPLACE', 'BOOKING_SITE'] as const;
export const PAYMENT_MODES = ['ONLINE', 'PAY_AT_HOTEL'] as const;
export const STAY_TYPES = ['NIGHTLY', 'DAY_USE'] as const;

export class AvailabilityQueryDto {
  @IsOptional() @IsIn(STAY_TYPES) stayType?: (typeof STAY_TYPES)[number];
  @IsOptional() @Matches(DATE_RE, { message: 'checkIn must be YYYY-MM-DD' }) checkIn?: string;
  @IsOptional() @Matches(DATE_RE, { message: 'checkOut must be YYYY-MM-DD' }) checkOut?: string;
  @IsOptional() @Matches(DATE_RE, { message: 'date must be YYYY-MM-DD' }) date?: string;
  @IsOptional() @Matches(TIME_RE, { message: 'startTime must be HH:MM' }) startTime?: string;
  @IsOptional() @Type(() => Number) @IsInt() @Min(2) @Max(12) hours?: number;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(10) adults?: number;
  @IsOptional() @Type(() => Number) @IsInt() @Min(0) @Max(10) children?: number;
  /** Alias of adults. */
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(20) guests?: number;
  /** M4 */
  @IsOptional() @IsString() @MaxLength(30) promoCode?: string;
  @IsOptional() @IsIn(CHANNELS) channel?: (typeof CHANNELS)[number];
}

export class PriceCalendarQueryDto {
  @Matches(DATE_RE, { message: 'from must be YYYY-MM-DD' }) from!: string;
  @Matches(DATE_RE, { message: 'to must be YYYY-MM-DD' }) to!: string;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(10) adults?: number;
  @IsOptional() @Type(() => Number) @IsInt() @Min(0) @Max(10) children?: number;
  @IsOptional() @IsString() @Length(36, 36) roomTypeId?: string;
  @IsOptional() @IsString() @Length(36, 36) ratePlanId?: string;
  @IsOptional() @IsIn(CHANNELS) channel?: (typeof CHANNELS)[number];
}

export class QuoteDto {
  @IsString() @Length(1, 120) @Transform(trim) hotelSlug!: string;
  @IsString() @Length(36, 36) roomTypeId!: string;
  @IsIn(CHANNELS) channel!: (typeof CHANNELS)[number];
  @IsOptional() @IsIn(STAY_TYPES) stayType?: (typeof STAY_TYPES)[number];
  @IsOptional() @Matches(DATE_RE, { message: 'checkIn must be YYYY-MM-DD' }) checkIn?: string;
  @IsOptional() @Matches(DATE_RE, { message: 'checkOut must be YYYY-MM-DD' }) checkOut?: string;
  @IsOptional() @Matches(DATE_RE, { message: 'date must be YYYY-MM-DD' }) date?: string;
  @IsOptional() @Matches(TIME_RE, { message: 'startTime must be HH:MM' }) startTime?: string;
  @IsOptional() @IsInt() @Min(2) @Max(12) hours?: number;
  @IsOptional() @IsInt() @Min(1) @Max(10) adults?: number;
  @IsOptional() @IsInt() @Min(0) @Max(10) children?: number;
  /** M4 */
  @IsOptional() @IsString() @Length(36, 36) ratePlanId?: string;
  @IsOptional() @IsString() @MaxLength(30) promoCode?: string;
}

export class BookingGuestDto {
  @IsString() @Length(2, 120) @Transform(trim) fullName!: string;
  @IsString() @Length(7, 24) phone!: string;
  @IsOptional() @IsEmail() @MaxLength(160) @Transform(trim) email?: string;
}

export class CreateBookingDto {
  @IsString() @Length(20, 4000) quoteToken!: string;
  @IsIn(PAYMENT_MODES) paymentMode!: (typeof PAYMENT_MODES)[number];
  @IsOptional() @ValidateNested() @Type(() => BookingGuestDto) guest?: BookingGuestDto;
  @IsOptional() @IsString() @MaxLength(500) specialRequests?: string;
  @IsOptional() @IsBoolean() marketingOptIn?: boolean;
  @IsBoolean() @Equals(true, { message: 'Please accept the processing of your details to book' }) consent!: boolean;
  @IsOptional() @IsString() @MaxLength(500) callbackUrl?: string;
}

export class DevConfirmDto {
  @IsIn(['success', 'failed']) outcome!: 'success' | 'failed';
  @IsOptional() @IsIn(['card', 'bank_transfer', 'ussd', 'bank']) channel?: string;
  @IsOptional() @IsInt() @Min(1) amountKobo?: number;
}

export class TripCancelDto {
  @IsOptional() @IsString() @MaxLength(300) reason?: string;
}

export class TripTokenQueryDto {
  @IsString() @Length(10, 1000) t!: string;
}

export class OutboxQueryDto {
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(50) limit?: number;
  @IsOptional() @IsString() @MaxLength(160) to?: string;
}

// -----------------------------------------------------------------------------
// Admin
// -----------------------------------------------------------------------------

export class CancellationPolicyDto {
  @IsOptional() @IsInt() @Min(0) @Max(720) freeCancellationHours?: number;
  @IsOptional() @IsInt() @Min(0) @Max(100) lateCancellationFeePct?: number;
  @IsOptional() @IsInt() @Min(0) @Max(100) noShowFeePct?: number;
}

export class UpdateBookingSettingsDto {
  @IsOptional() @IsBoolean() onlineBookingEnabled?: boolean;
  @IsOptional() @IsBoolean() allowPayAtHotel?: boolean;
  @IsOptional() @IsBoolean() requireCardForPayAtHotel?: boolean;
  @IsOptional() @ValidateNested() @Type(() => CancellationPolicyDto) cancellationPolicy?: CancellationPolicyDto;
  @IsOptional() @IsString() @MaxLength(500) preArrivalMessage?: string;
}

export class ResolveAccountDto {
  @IsString() @Length(2, 10) bankCode!: string;
  @Matches(/^\d{10}$/, { message: 'accountNumber must be a 10-digit NUBAN' }) accountNumber!: string;
}

export class SavePayoutAccountDto extends ResolveAccountDto {
  @IsOptional() @IsString() @Length(2, 120) @Transform(trim) businessName?: string;
}

export class RangeQueryDto extends PaginationQueryDto {
  @IsOptional() @Matches(DATE_RE, { message: 'from must be YYYY-MM-DD' }) from?: string;
  @IsOptional() @Matches(DATE_RE, { message: 'to must be YYYY-MM-DD' }) to?: string;
  @IsOptional() @IsIn(['ACCRUED', 'COLLECTED', 'REVERSED']) kind?: 'ACCRUED' | 'COLLECTED' | 'REVERSED';
}

export class FeedQueryDto {
  @IsOptional() @IsString() @MaxLength(40) since?: string;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(100) limit?: number;
}

export class NotificationQueryDto extends PaginationQueryDto {
  @IsOptional() @IsString() @MaxLength(40) template?: string;
  @IsOptional() @IsIn(['EMAIL', 'SMS', 'WHATSAPP']) channel?: 'EMAIL' | 'SMS' | 'WHATSAPP';
  @IsOptional() @IsIn(['QUEUED', 'SENT', 'FAILED', 'OUTBOX']) status?: 'QUEUED' | 'SENT' | 'FAILED' | 'OUTBOX';
}
