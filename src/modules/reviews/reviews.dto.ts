import { Transform, Type } from 'class-transformer';
import { IsBoolean, IsIn, IsInt, IsOptional, IsString, Length, Matches, Max, MaxLength, Min } from 'class-validator';
import { PaginationQueryDto } from '../../common/utils/pagination.dto.js';
import { TRAVELLER_TYPES } from './reviews.logic.js';

const trim = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value);
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export class PublicReviewsQueryDto {
  @IsOptional() @IsIn(TRAVELLER_TYPES) travellerType?: (typeof TRAVELLER_TYPES)[number];
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(5) rating?: number;
  @IsOptional() @IsIn(['recent', 'highest', 'lowest']) sort?: 'recent' | 'highest' | 'lowest';
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) page?: number;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(50) pageSize?: number;
}

export class ReviewTokenQueryDto {
  @IsString() @Length(10, 1000) t!: string;
}

export class SubmitReviewDto {
  @IsString() @Length(10, 1000) token!: string;
  @IsInt() @Min(1) @Max(5) overall!: number;
  @IsInt() @Min(1) @Max(5) cleanliness!: number;
  @IsInt() @Min(1) @Max(5) service!: number;
  @IsInt() @Min(1) @Max(5) location!: number;
  @IsInt() @Min(1) @Max(5) value!: number;
  @IsOptional() @IsString() @MaxLength(120) @Transform(trim) title?: string;
  @IsString() @Length(20, 2000) @Transform(trim) body!: string;
  @IsIn(TRAVELLER_TYPES) travellerType!: (typeof TRAVELLER_TYPES)[number];
}

export class HotelReviewsQueryDto extends PaginationQueryDto {
  @IsOptional() @IsIn(['PUBLISHED', 'HIDDEN', 'FLAGGED']) status?: 'PUBLISHED' | 'HIDDEN' | 'FLAGGED';
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(5) rating?: number;
  @IsOptional() @IsIn(TRAVELLER_TYPES) travellerType?: (typeof TRAVELLER_TYPES)[number];
  @IsOptional() @Transform(({ value }) => (value === 'true' ? true : value === 'false' ? false : value)) @IsBoolean() replied?: boolean;
  @IsOptional() @Matches(DATE_RE) from?: string;
  @IsOptional() @Matches(DATE_RE) to?: string;
}

export class ReviewSummaryQueryDto {
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(36) months?: number;
}

export class ReplyDto {
  @IsString() @Length(2, 2000) @Transform(trim) body!: string;
}

export class FlagReviewDto {
  @IsString() @Length(5, 300) @Transform(trim) reason!: string;
}

export class PlatformReviewsQueryDto extends PaginationQueryDto {
  @IsOptional() @IsIn(['PUBLISHED', 'HIDDEN', 'FLAGGED']) status?: 'PUBLISHED' | 'HIDDEN' | 'FLAGGED';
  @IsOptional() @IsString() @MaxLength(120) q?: string;
}

export class ModerateReviewDto {
  @IsIn(['HIDDEN', 'PUBLISHED']) status!: 'HIDDEN' | 'PUBLISHED';
  @IsOptional() @IsIn(['ABUSE', 'PII', 'SPAM', 'OFF_TOPIC', 'OTHER']) reason?: 'ABUSE' | 'PII' | 'SPAM' | 'OFF_TOPIC' | 'OTHER';
  @IsOptional() @IsString() @MaxLength(500) note?: string;
}
