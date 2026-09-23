import { Type } from 'class-transformer';
import { ArrayMaxSize, IsArray, IsBoolean, IsIn, IsInt, IsObject, IsOptional, IsString, IsUrl, IsUUID, Matches, Max, MaxLength, Min, ValidateNested } from 'class-validator';
import { PaginationQueryDto } from '../../common/utils/pagination.dto.js';

export const OTA_CHANNELS = ['AIRBNB', 'BOOKING_COM', 'EXPEDIA', 'AGODA', 'VRBO', 'HOTELS_NG', 'OTHER'] as const;
type Ota = (typeof OTA_CHANNELS)[number];
const DATE = /^\d{4}-\d{2}-\d{2}$/;

export class CreateConnectionDto {
  @IsIn(['ICAL', 'CHANNEX']) provider!: 'ICAL' | 'CHANNEX';
  @IsOptional() @IsIn(OTA_CHANNELS) channel?: Ota;
  @IsOptional() @IsString() @MaxLength(80) name?: string;
  @IsOptional() @IsInt() @Min(0) @Max(50) stopSellBuffer?: number;
  @IsOptional() commissionBps?: number | Partial<Record<Ota, number>>;
  @IsOptional() @IsString() @MaxLength(200) apiKey?: string;
  @IsOptional() @IsString() @MaxLength(100) externalPropertyId?: string;
}

export class UpdateConnectionDto {
  @IsOptional() @IsString() @MaxLength(80) name?: string;
  @IsOptional() @IsIn(['ACTIVE', 'PAUSED']) status?: 'ACTIVE' | 'PAUSED';
  @IsOptional() @IsInt() @Min(0) @Max(50) stopSellBuffer?: number;
  @IsOptional() commissionBps?: number | Partial<Record<Ota, number>>;
  @IsOptional() @IsBoolean() pushRates?: boolean;
  @IsOptional() @IsBoolean() pushRestrictions?: boolean;
  @IsOptional() @IsInt() @Min(14) @Max(730) horizonDays?: number;
  @IsOptional() @IsString() @MaxLength(200) apiKey?: string;
}

export class SyncDto {
  @IsOptional() @IsBoolean() full?: boolean;
}

export class FeedDto {
  @IsOptional() @IsUUID() roomId?: string;
  @IsOptional() @IsUUID() roomTypeId?: string;
  @IsUrl({ protocols: ['http', 'https'], require_protocol: true, require_tld: false }) @MaxLength(2000) url!: string;
}

export class MappingDto {
  @IsUUID() roomTypeId!: string;
  @IsOptional() @IsUUID() ratePlanId?: string | null;
  @IsString() @MaxLength(100) externalRoomTypeId!: string;
  @IsOptional() @IsString() @MaxLength(100) externalRatePlanId?: string | null;
}

export class MappingsDto {
  @IsArray() @ArrayMaxSize(200) @ValidateNested({ each: true }) @Type(() => MappingDto) mappings!: MappingDto[];
}

export class BookingsQueryDto extends PaginationQueryDto {
  @IsOptional() @IsIn(OTA_CHANNELS) channel?: Ota;
  @IsOptional() @IsIn(['NEW', 'MODIFIED', 'CANCELLED']) status?: string;
  @IsOptional() @Matches(DATE) from?: string;
  @IsOptional() @Matches(DATE) to?: string;
}

export class LogsQueryDto extends PaginationQueryDto {
  @IsOptional() @IsUUID() connectionId?: string;
  @IsOptional() @IsIn(['OK', 'ERROR', 'SKIPPED']) status?: string;
}

export class CostQueryDto {
  @IsOptional() @Matches(/^\d{4}-(0[1-9]|1[0-2])$/) month?: string;
}

export class DevBookingDto {
  @IsUUID() connectionId!: string;
  @IsUUID() roomTypeId!: string;
  @Matches(DATE) checkIn!: string;
  @Matches(DATE) checkOut!: string;
  @IsOptional() @IsIn(OTA_CHANNELS) otaChannel?: Ota;
  @IsOptional() @IsString() @MaxLength(120) guestName?: string;
  @IsOptional() @IsInt() @Min(1) @Max(10) adults?: number;
  @IsOptional() @IsInt() @Min(0) amountKobo?: number;
  @IsOptional() @IsString() @MaxLength(80) cancelExternalId?: string;
  @IsOptional() @IsString() @MaxLength(80) modifyExternalId?: string;
}

export class ChannexWebhookDto {
  @IsOptional() @IsString() event?: string;
  @IsOptional() @IsString() property_id?: string;
  @IsOptional() @IsObject() payload?: { booking_id?: string; revision_id?: string };
}
