import { Type } from 'class-transformer';
import { ArrayMaxSize, ArrayMinSize, IsArray, IsBoolean, IsIn, IsInt, IsOptional, IsString, IsUUID, Matches, Max, MaxLength, Min, ValidateNested } from 'class-validator';
import { PaginationQueryDto } from '../../common/utils/pagination.dto.js';

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const IMPACTS = ['LOW', 'MEDIUM', 'HIGH', 'VERY_HIGH'] as const;
type Impact = (typeof IMPACTS)[number];
const MAX_KOBO = 100_000_000_000;

export class RangeQueryDto {
  @IsOptional() @Matches(DATE) from?: string;
  @IsOptional() @Matches(DATE) to?: string;
}

export class SettingsDto {
  @IsOptional() @IsIn(['OFF', 'SUGGEST', 'AUTOPILOT']) mode?: 'OFF' | 'SUGGEST' | 'AUTOPILOT';
  @IsOptional() @IsInt() @Min(14) @Max(365) horizonDays?: number;
  @IsOptional() @IsInt() @Min(0) @Max(5000) minChangeBps?: number;
  @IsOptional() @IsBoolean() paceSpikeEnabled?: boolean;
  @IsOptional() @IsInt() @Min(1) @Max(100) paceSpikeRooms?: number;
}

export class GuardrailDto {
  @IsOptional() @IsBoolean() enabled?: boolean;
  @IsOptional() @IsInt() @Min(100) @Max(MAX_KOBO) floorKobo?: number;
  @IsOptional() @IsInt() @Min(100) @Max(MAX_KOBO) ceilingKobo?: number;
  @IsOptional() @IsInt() @Min(100) @Max(10_000) maxDailyChangeBps?: number;
}

export class FrozenDto {
  @IsOptional() @Matches(DATE) date?: string;
  @IsOptional() @Matches(DATE) dateFrom?: string;
  @IsOptional() @Matches(DATE) dateTo?: string;
  @IsOptional() @IsUUID() roomTypeId?: string | null;
  @IsOptional() @IsString() @MaxLength(200) note?: string;
}

export class CreateEventDto {
  @IsString() @MaxLength(120) name!: string;
  @Matches(DATE) dateFrom!: string;
  @Matches(DATE) dateTo!: string;
  @IsOptional() @IsIn(IMPACTS) impact?: Impact;
  @IsOptional() @IsInt() @Min(-5000) @Max(10_000) upliftBps?: number;
  @IsOptional() @IsString() @MaxLength(80) city?: string | null;
  @IsOptional() @IsString() @MaxLength(500) note?: string;
}

export class PatchEventDto {
  @IsOptional() @IsString() @MaxLength(120) name?: string;
  @IsOptional() @Matches(DATE) dateFrom?: string;
  @IsOptional() @Matches(DATE) dateTo?: string;
  @IsOptional() @IsIn(IMPACTS) impact?: Impact;
  @IsOptional() @IsInt() @Min(-5000) @Max(10_000) upliftBps?: number;
  @IsOptional() @IsString() @MaxLength(80) city?: string | null;
  @IsOptional() @IsString() @MaxLength(500) note?: string;
  @IsOptional() @IsBoolean() disabled?: boolean;
}

export class CompetitorEntryDto {
  @IsString() @MaxLength(120) competitorName!: string;
  @Matches(DATE) date!: string;
  @IsInt() @Min(100) @Max(MAX_KOBO) rateKobo!: number;
  @IsOptional() @IsUUID() roomTypeId?: string | null;
}

export class CompetitorsDto {
  @IsArray() @ArrayMaxSize(1000) @ValidateNested({ each: true }) @Type(() => CompetitorEntryDto) entries!: CompetitorEntryDto[];
}

export class SuggestionsQueryDto extends RangeQueryDto {
  @IsOptional() @IsUUID() roomTypeId?: string;
  @IsOptional() @IsIn(['PENDING', 'ACCEPTED', 'REJECTED', 'APPLIED', 'SUPERSEDED', 'EXPIRED']) status?: 'PENDING' | 'ACCEPTED' | 'REJECTED' | 'APPLIED' | 'SUPERSEDED' | 'EXPIRED';
}

export class AcceptDto {
  @IsOptional() @IsInt() @Min(100) @Max(MAX_KOBO) priceKobo?: number;
}

export class RejectDto {
  @IsOptional() @IsString() @MaxLength(300) note?: string;
}

export class BulkDto {
  @IsArray() @ArrayMinSize(1) @ArrayMaxSize(500) @IsUUID('all', { each: true }) ids!: string[];
  @IsIn(['ACCEPT', 'REJECT']) action!: 'ACCEPT' | 'REJECT';
}

export class ChangesQueryDto extends PaginationQueryDto {
  @IsOptional() @Matches(DATE) from?: string;
  @IsOptional() @Matches(DATE) to?: string;
  @IsOptional() @IsUUID() roomTypeId?: string;
  @IsOptional() @IsIn(['ACCEPTED', 'AUTOPILOT', 'REVERT']) source?: 'ACCEPTED' | 'AUTOPILOT' | 'REVERT';
}

export class PreviewQueryDto {
  @IsUUID() roomTypeId!: string;
  @Matches(DATE) date!: string;
}
