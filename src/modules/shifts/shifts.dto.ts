import { IsInt, IsObject, IsOptional, IsString, IsUUID, Matches, Max, MaxLength, Min, IsIn } from 'class-validator';
import { PaginationQueryDto } from '../../common/utils/pagination.dto.js';
import { MAX_AMOUNT_KOBO } from '../ops/ops.helpers.js';

export class OpenShiftDto {
  @IsInt() @Min(0) @Max(MAX_AMOUNT_KOBO) openingFloatKobo!: number;
  @IsOptional() @IsString() @MaxLength(500) notes?: string;
}

export class CloseShiftDto {
  @IsInt() @Min(0) @Max(MAX_AMOUNT_KOBO) countedCashKobo!: number;
  @IsInt() @Min(0) @Max(MAX_AMOUNT_KOBO) declaredPosKobo!: number;
  @IsInt() @Min(0) @Max(MAX_AMOUNT_KOBO) declaredTransferKobo!: number;
  /** Naira note -> count, e.g. { "1000": 42, "500": 10 }. */
  @IsOptional() @IsObject() denominations?: Record<string, number>;
  @IsOptional() @IsString() @MaxLength(500) notes?: string;
}

export class ApproveShiftDto {
  @IsOptional() @IsString() @MaxLength(500) notes?: string;
}

export class ShiftQueryDto extends PaginationQueryDto {
  @IsOptional() @IsIn(['OPEN', 'CLOSED', 'APPROVED']) status?: 'OPEN' | 'CLOSED' | 'APPROVED';
  @IsOptional() @IsUUID() userId?: string;
  @IsOptional() @Matches(/^\d{4}-\d{2}-\d{2}$/) from?: string;
  @IsOptional() @Matches(/^\d{4}-\d{2}-\d{2}$/) to?: string;
}
