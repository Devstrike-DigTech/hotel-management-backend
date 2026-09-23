import { Type } from 'class-transformer';
import { ArrayMaxSize, IsArray, IsBoolean, IsEmail, IsIn, IsInt, IsISO8601, IsOptional, IsString, IsUUID, Matches, Max, MaxLength, Min, MinLength, ValidateIf } from 'class-validator';
import { PaginationQueryDto } from '../../common/utils/pagination.dto.js';

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const MAX = 100_000_000_000;

export class CorporateAccountDto {
  @IsString() @MinLength(2) @MaxLength(120) name!: string;
  @IsOptional() @IsString() @MaxLength(120) contactName?: string;
  @IsEmail() @MaxLength(254) email!: string;
  @IsOptional() @IsString() @MaxLength(30) phone?: string;
  @IsOptional() @IsString() @MaxLength(300) address?: string;
  @IsOptional() @IsString() @MaxLength(30) taxId?: string;
  @IsOptional() @IsUUID() ratePlanId?: string;
  @IsInt() @Min(0) @Max(MAX) creditLimitKobo!: number;
  @IsOptional() @IsInt() @Min(0) @Max(365) paymentTermsDays?: number;
  @IsOptional() @IsIn(['PER_STAY', 'MONTHLY']) billingCycle?: 'PER_STAY' | 'MONTHLY';
  @IsOptional() @IsBoolean() active?: boolean;
  @IsOptional() @IsString() @MaxLength(1000) notes?: string;
}

export class UpdateCorporateAccountDto {
  @IsOptional() @IsString() @MinLength(2) @MaxLength(120) name?: string;
  @IsOptional() @IsString() @MaxLength(120) contactName?: string;
  @IsOptional() @IsEmail() @MaxLength(254) email?: string;
  @IsOptional() @IsString() @MaxLength(30) phone?: string;
  @IsOptional() @IsString() @MaxLength(300) address?: string;
  @IsOptional() @IsString() @MaxLength(30) taxId?: string;
  @IsOptional() @ValidateIf((_o, v) => v !== null) @IsUUID() ratePlanId?: string | null;
  @IsOptional() @IsInt() @Min(0) @Max(MAX) creditLimitKobo?: number;
  @IsOptional() @IsInt() @Min(0) @Max(365) paymentTermsDays?: number;
  @IsOptional() @IsIn(['PER_STAY', 'MONTHLY']) billingCycle?: 'PER_STAY' | 'MONTHLY';
  @IsOptional() @IsBoolean() active?: boolean;
  @IsOptional() @IsString() @MaxLength(1000) notes?: string;
}

export class AccountQueryDto {
  @IsOptional() @IsString() active?: string;
  @IsOptional() @IsString() @MaxLength(60) q?: string;
}

export class LedgerQueryDto extends PaginationQueryDto {
  @IsOptional() @IsUUID() accountId?: string;
  @IsOptional() @IsString() invoiced?: string;
  @IsOptional() @IsString() @MaxLength(60) status?: string;
  @IsOptional() @IsString() overdue?: string;
  @IsOptional() @IsIn(['CURRENT', 'D31_60', 'D61_90', 'D90_PLUS']) bucket?: string;
  @IsOptional() @Matches(DATE) from?: string;
  @IsOptional() @Matches(DATE) to?: string;
}

export class CreateStatementDto {
  @IsUUID() accountId!: string;
  @IsOptional() @IsArray() @ArrayMaxSize(500) @IsUUID('all', { each: true }) chargeIds?: string[];
  @IsOptional() @Matches(DATE) periodFrom?: string;
  @IsOptional() @Matches(DATE) periodTo?: string;
  @IsOptional() @IsString() @MaxLength(500) notes?: string;
}

export class LedgerPaymentDto {
  @IsInt() @Min(1) @Max(MAX) amountKobo!: number;
  @IsIn(['TRANSFER', 'CHEQUE', 'CASH', 'POS']) method!: 'TRANSFER' | 'CHEQUE' | 'CASH' | 'POS';
  @IsOptional() @IsString() @MaxLength(80) reference?: string;
  @IsOptional() @IsISO8601() receivedAt?: string;
  @IsOptional() @IsString() @MaxLength(300) note?: string;
}

export class AccountPaymentDto extends LedgerPaymentDto {
  @IsUUID() accountId!: string;
}

export class RemindDto {
  @IsOptional() @IsString() @MaxLength(500) message?: string;
}

export class VoidStatementDto {
  @IsString() @MinLength(3) @MaxLength(300) reason!: string;
}

export class ShareStatementDto {
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(720) expiresInHours?: number;
}
