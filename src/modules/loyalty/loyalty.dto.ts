import { ArrayMaxSize, IsArray, IsBoolean, IsIn, IsInt, IsOptional, IsString, IsUUID, Matches, Max, MaxLength, Min, MinLength, NotEquals, ValidateNested } from 'class-validator';
import { Type } from 'class-transformer';
import { PaginationQueryDto } from '../../common/utils/pagination.dto.js';
import { TIER_COLORS } from './loyalty.logic.js';

export class ProgrammeDto {
  @IsOptional() @IsBoolean() enabled?: boolean;
  @IsOptional() @IsString() @MinLength(2) @MaxLength(60) name?: string;
  @IsOptional() @IsInt() @Min(0) @Max(1000) earnPointsPer1000?: number;
  @IsOptional() @IsInt() @Min(1) @Max(100_000) pointValueKobo?: number;
  @IsOptional() @IsInt() @Min(1) @Max(1_000_000) minRedeemPoints?: number;
  @IsOptional() @IsInt() @Min(100) @Max(10_000) maxRedeemBps?: number;
  @IsOptional() @IsInt() @Min(0) @Max(120) expiryMonths?: number;
  @IsOptional() @IsInt() @Min(1) @Max(10_000_000) adjustmentFlagPoints?: number;
  @IsOptional() @IsBoolean() enrolOnline?: boolean;
  @IsOptional() @IsString() @Matches(/^[A-Z]{2,6}$/, { message: 'memberNoPrefix must be 2-6 capital letters' }) memberNoPrefix?: string;
}

export class TierDto {
  @IsString() @MinLength(2) @MaxLength(40) name!: string;
  @IsInt() @Min(0) @Max(365) minNights!: number;
  @IsOptional() @IsInt() @Min(0) @Max(10_000) bonusBps?: number;
  @IsOptional() @IsArray() @ArrayMaxSize(10) @IsString({ each: true }) @MaxLength(120, { each: true }) perks?: string[];
  @IsOptional() @IsIn(TIER_COLORS) color?: string;
  @IsOptional() @IsInt() @Min(0) @Max(1000) sortOrder?: number;
}

export class UpdateTierDto {
  @IsOptional() @IsString() @MinLength(2) @MaxLength(40) name?: string;
  @IsOptional() @IsInt() @Min(0) @Max(365) minNights?: number;
  @IsOptional() @IsInt() @Min(0) @Max(10_000) bonusBps?: number;
  @IsOptional() @IsArray() @ArrayMaxSize(10) @IsString({ each: true }) @MaxLength(120, { each: true }) perks?: string[];
  @IsOptional() @IsIn(TIER_COLORS) color?: string;
  @IsOptional() @IsInt() @Min(0) @Max(1000) sortOrder?: number;
}

export class MembersQueryDto extends PaginationQueryDto {
  @IsOptional() @IsString() @MaxLength(100) q?: string;
  @IsOptional() @IsUUID() tierId?: string;
}

export class EnrolDto {
  @IsUUID() guestId!: string;
  @IsOptional() @IsIn(['DESK', 'CHECK_IN']) via?: 'DESK' | 'CHECK_IN';
}

export class AdjustDto {
  @IsInt() @NotEquals(0) @Min(-10_000_000) @Max(10_000_000) points!: number;
  @IsString() @MinLength(3) @MaxLength(300) reason!: string;
}

export class RedeemStartDto {
  @IsUUID() folioId!: string;
  @IsInt() @Min(1) @Max(10_000_000) points!: number;
}

export class ApprovalDto {
  @IsUUID() approverId!: string;
  @IsString() @Matches(/^\d{4,6}$/, { message: 'pin must be 4 to 6 digits' }) pin!: string;
}

export class RedeemDto {
  @IsOptional() @IsUUID() challengeId?: string;
  @IsOptional() @IsString() @Matches(/^\d{6}$/, { message: 'code must be 6 digits' }) code?: string;
  @IsOptional() @IsUUID() memberId?: string;
  @IsOptional() @IsUUID() folioId?: string;
  @IsOptional() @IsInt() @Min(1) @Max(10_000_000) points?: number;
  @IsOptional() @ValidateNested() @Type(() => ApprovalDto) approval?: ApprovalDto;
}

export class GuestEnrolDto {
  @IsString() @MinLength(1) @MaxLength(120) hotelSlug!: string;
}
