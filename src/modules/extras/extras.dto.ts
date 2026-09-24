import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsISO8601,
  IsObject,
  IsOptional,
  IsString,
  IsUUID,
  Length,
  Matches,
  Max,
  MaxLength,
  Min,
  MinLength,
  ValidateIf,
  ValidateNested,
} from 'class-validator';

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
export const EXTRA_CATEGORIES = ['TRANSPORT', 'FOOD', 'EARLY_LATE', 'CELEBRATION', 'WELLNESS', 'OTHER'] as const;
export const EXTRA_PRICING = ['PER_STAY', 'PER_NIGHT', 'PER_PERSON', 'PER_PERSON_PER_NIGHT', 'PER_UNIT'] as const;
export const EXTRA_KINDS = ['STANDARD', 'EARLY_CHECK_IN', 'LATE_CHECK_OUT'] as const;
export const CHANNEL_CODES = ['MARKETPLACE', 'BOOKING_SITE', 'FRONT_DESK'] as const;
export const PICKUP_KINDS = ['AIRPORT', 'MOTOR_PARK', 'TRAIN_STATION', 'JETTY', 'OTHER'] as const;
export const TRANSFER_STATUSES = ['REQUESTED', 'CONFIRMED', 'DRIVER_ASSIGNED', 'EN_ROUTE', 'PICKED_UP', 'COMPLETED', 'NO_SHOW', 'CANCELLED'] as const;

const nullable = () => ValidateIf((_o, v) => v !== null);

export class ExtraAvailabilityDto {
  @IsOptional() @nullable() @Matches(DATE_RE) validFrom?: string | null;
  @IsOptional() @nullable() @Matches(DATE_RE) validTo?: string | null;
  @IsOptional() @nullable() @IsArray() @ArrayMaxSize(7) @IsInt({ each: true }) @Min(0, { each: true }) @Max(6, { each: true }) daysOfWeek?: number[] | null;
  @IsOptional() @nullable() @IsInt() @Min(1) @Max(60) minNights?: number | null;
  @IsOptional() @nullable() @Matches(TIME_RE) earlyFrom?: string | null;
  @IsOptional() @nullable() @Matches(TIME_RE) lateUntil?: string | null;
}

export class ExtraDto {
  @IsString() @Length(2, 80) name!: string;
  @IsOptional() @IsString() @MaxLength(400) description?: string;
  @IsOptional() @nullable() @IsString() @MaxLength(500) imageUrl?: string | null;
  @IsIn(EXTRA_CATEGORIES) category!: (typeof EXTRA_CATEGORIES)[number];
  @IsOptional() @IsIn(EXTRA_KINDS) kind?: (typeof EXTRA_KINDS)[number];
  @IsIn(EXTRA_PRICING) pricing!: (typeof EXTRA_PRICING)[number];
  @IsInt() @Min(1) @Max(100_000_000) priceKobo!: number;
  @IsOptional() @nullable() @IsInt() @Min(1) @Max(50) maxUnits?: number | null;
  @IsOptional() @IsBoolean() taxable?: boolean;
  @IsOptional() @IsArray() @ArrayMinSize(1) @IsIn(CHANNEL_CODES, { each: true }) channels?: string[];
  @IsOptional() @ValidateNested() @Type(() => ExtraAvailabilityDto) availability?: ExtraAvailabilityDto;
  @IsOptional() @nullable() @IsInt() @Min(1) @Max(1000) dailyCap?: number | null;
  @IsOptional() @IsInt() @Min(0) @Max(168) leadTimeHours?: number;
  @IsOptional() @IsBoolean() active?: boolean;
  @IsOptional() @IsInt() @Min(0) @Max(1000) sortOrder?: number;
}

export class UpdateExtraDto {
  @IsOptional() @IsString() @Length(2, 80) name?: string;
  @IsOptional() @IsString() @MaxLength(400) description?: string;
  @IsOptional() @nullable() @IsString() @MaxLength(500) imageUrl?: string | null;
  @IsOptional() @IsIn(EXTRA_CATEGORIES) category?: (typeof EXTRA_CATEGORIES)[number];
  @IsOptional() @IsIn(EXTRA_KINDS) kind?: (typeof EXTRA_KINDS)[number];
  @IsOptional() @IsIn(EXTRA_PRICING) pricing?: (typeof EXTRA_PRICING)[number];
  @IsOptional() @IsInt() @Min(1) @Max(100_000_000) priceKobo?: number;
  @IsOptional() @nullable() @IsInt() @Min(1) @Max(50) maxUnits?: number | null;
  @IsOptional() @IsBoolean() taxable?: boolean;
  @IsOptional() @IsArray() @ArrayMinSize(1) @IsIn(CHANNEL_CODES, { each: true }) channels?: string[];
  @IsOptional() @ValidateNested() @Type(() => ExtraAvailabilityDto) availability?: ExtraAvailabilityDto;
  @IsOptional() @nullable() @IsInt() @Min(1) @Max(1000) dailyCap?: number | null;
  @IsOptional() @IsInt() @Min(0) @Max(168) leadTimeHours?: number;
  @IsOptional() @IsBoolean() active?: boolean;
  @IsOptional() @IsInt() @Min(0) @Max(1000) sortOrder?: number;
}

export class ExtraSelectionDto {
  @IsUUID() extraId!: string;
  @IsOptional() @IsInt() @Min(1) @Max(50) quantity?: number;
}

export class ExtrasQuoteDto {
  @IsArray() @ArrayMaxSize(20) @ValidateNested({ each: true }) @Type(() => ExtraSelectionDto) extras!: ExtraSelectionDto[];
  @Matches(DATE_RE) arrivalDate!: string;
  @Matches(DATE_RE) departureDate!: string;
  @IsInt() @Min(1) @Max(10) adults!: number;
  @IsOptional() @IsInt() @Min(0) @Max(10) children?: number;
  @IsOptional() @IsIn(CHANNEL_CODES) channel?: (typeof CHANNEL_CODES)[number];
}

export class VehicleOptionDto {
  @IsOptional() @IsString() @Length(1, 40) id?: string;
  @IsString() @Length(2, 40) name!: string;
  @IsInt() @Min(1) @Max(60) maxPassengers!: number;
  @IsOptional() @nullable() @IsInt() @Min(0) @Max(100_000_000) priceKobo?: number | null;
}

export class OperatingHoursDto {
  @Matches(TIME_RE) open!: string;
  @Matches(TIME_RE) close!: string;
}

export class PickupPointDto {
  @IsString() @Length(2, 100) name!: string;
  @IsOptional() @nullable() @IsString() @MaxLength(20) shortName?: string | null;
  @IsIn(PICKUP_KINDS) kind!: (typeof PICKUP_KINDS)[number];
  @IsString() @Length(2, 60) city!: string;
  @IsOptional() @nullable() @IsString() @MaxLength(200) address?: string | null;
  @IsInt() @Min(0) @Max(100_000_000) priceKobo!: number;
  @IsOptional() @nullable() @IsInt() @Min(0) @Max(100_000_000) dropOffPriceKobo?: number | null;
  @IsOptional() @IsArray() @ArrayMaxSize(8) @ValidateNested({ each: true }) @Type(() => VehicleOptionDto) vehicleOptions?: VehicleOptionDto[];
  @IsOptional() @IsInt() @Min(0) @Max(72) leadTimeHours?: number;
  @IsOptional() @nullable() @ValidateNested() @Type(() => OperatingHoursDto) operatingHours?: OperatingHoursDto | null;
  @IsOptional() @nullable() @IsString() @MaxLength(400) notesForGuest?: string | null;
  @IsOptional() @IsBoolean() taxable?: boolean;
  @IsOptional() @IsBoolean() active?: boolean;
  @IsOptional() @IsInt() @Min(0) @Max(1000) sortOrder?: number;
}

export class UpdatePickupPointDto {
  @IsOptional() @IsString() @Length(2, 100) name?: string;
  @IsOptional() @nullable() @IsString() @MaxLength(20) shortName?: string | null;
  @IsOptional() @IsIn(PICKUP_KINDS) kind?: (typeof PICKUP_KINDS)[number];
  @IsOptional() @IsString() @Length(2, 60) city?: string;
  @IsOptional() @nullable() @IsString() @MaxLength(200) address?: string | null;
  @IsOptional() @IsInt() @Min(0) @Max(100_000_000) priceKobo?: number;
  @IsOptional() @nullable() @IsInt() @Min(0) @Max(100_000_000) dropOffPriceKobo?: number | null;
  @IsOptional() @IsArray() @ArrayMaxSize(8) @ValidateNested({ each: true }) @Type(() => VehicleOptionDto) vehicleOptions?: VehicleOptionDto[];
  @IsOptional() @IsInt() @Min(0) @Max(72) leadTimeHours?: number;
  @IsOptional() @nullable() @ValidateNested() @Type(() => OperatingHoursDto) operatingHours?: OperatingHoursDto | null;
  @IsOptional() @nullable() @IsString() @MaxLength(400) notesForGuest?: string | null;
  @IsOptional() @IsBoolean() taxable?: boolean;
  @IsOptional() @IsBoolean() active?: boolean;
  @IsOptional() @IsInt() @Min(0) @Max(1000) sortOrder?: number;
}

export class TransportCompanyDto {
  @IsString() @Length(2, 80) name!: string;
  @IsOptional() @nullable() @IsString() @MaxLength(20) shortName?: string | null;
}

export class TransferSelectionDto {
  @IsIn(['ARRIVAL', 'DEPARTURE']) direction!: 'ARRIVAL' | 'DEPARTURE';
  @IsUUID() pickupPointId!: string;
  @IsOptional() @nullable() @IsString() @MaxLength(40) vehicleOptionId?: string | null;
  @IsInt() @Min(1) @Max(60) passengers!: number;
  @IsISO8601() scheduledAt!: string;
}

export class DeskTransferDto extends TransferSelectionDto {
  @IsOptional() @IsObject() details?: Record<string, unknown>;
  @IsOptional() @nullable() @IsInt() @Min(0) @Max(20) luggage?: number | null;
  @IsOptional() @nullable() @IsString() @MaxLength(24) contactPhone?: string | null;
  @IsOptional() @nullable() @IsString() @MaxLength(500) notes?: string | null;
}

export class TransferQueryDto {
  @IsOptional() @Matches(DATE_RE) date?: string;
  @IsOptional() @Matches(DATE_RE) from?: string;
  @IsOptional() @Matches(DATE_RE) to?: string;
  @IsOptional() @IsString() @MaxLength(200) status?: string;
  @IsOptional() @IsIn(['ARRIVAL', 'DEPARTURE']) direction?: 'ARRIVAL' | 'DEPARTURE';
}

export class UpdateTransferDto {
  @IsOptional() @IsISO8601() scheduledAt?: string;
  @IsOptional() @IsInt() @Min(1) @Max(60) passengers?: number;
  @IsOptional() @nullable() @IsInt() @Min(0) @Max(20) luggage?: number | null;
  @IsOptional() @nullable() @IsString() @MaxLength(24) contactPhone?: string | null;
  @IsOptional() @nullable() @IsString() @MaxLength(500) notes?: string | null;
  @IsOptional() @IsObject() details?: Record<string, unknown>;
}

export class AssignDriverDto {
  @IsString() @Length(2, 80) driverName!: string;
  @IsString() @Length(7, 24) driverPhone!: string;
  @IsString() @Length(3, 16) @Matches(/^[A-Za-z0-9 -]+$/, { message: 'vehiclePlate: letters, digits, spaces and dashes' }) vehiclePlate!: string;
  @IsOptional() @IsString() @MaxLength(80) vehicleDescription?: string;
  @IsOptional() @IsBoolean() notifyGuest?: boolean;
}

export class TransferStatusDto {
  @IsIn(TRANSFER_STATUSES) status!: (typeof TRANSFER_STATUSES)[number];
  @IsOptional() @IsString() @MaxLength(200) note?: string;
  @IsOptional() @IsBoolean() notifyGuest?: boolean;
}

export class TransferDelayDto {
  @IsString() @MinLength(3) @MaxLength(200) note!: string;
  @IsOptional() @IsISO8601() newScheduledAt?: string;
  @IsOptional() @IsBoolean() notifyGuest?: boolean;
}

export class PublicExtrasQueryDto {
  @IsOptional() @IsIn(['MARKETPLACE', 'BOOKING_SITE']) channel?: 'MARKETPLACE' | 'BOOKING_SITE';
  @IsOptional() @Matches(DATE_RE) checkIn?: string;
  @IsOptional() @Matches(DATE_RE) checkOut?: string;
  @IsOptional() @Matches(DATE_RE) date?: string;
  @IsOptional() @Matches(TIME_RE) startTime?: string;
  @IsOptional() @Type(() => Number) @IsInt() @Min(2) @Max(12) hours?: number;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(10) adults?: number;
  @IsOptional() @Type(() => Number) @IsInt() @Min(0) @Max(10) children?: number;
}

export class HotelQueryDto {
  @IsOptional() @IsString() @MaxLength(120) hotel?: string;
}
