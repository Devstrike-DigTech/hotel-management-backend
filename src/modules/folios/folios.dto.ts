import { Type } from 'class-transformer';
import {
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
  ValidateNested,
} from 'class-validator';
import { PaginationQueryDto } from '../../common/utils/pagination.dto.js';
import { MAX_AMOUNT_KOBO } from '../ops/ops.helpers.js';

const METHODS = ['CASH', 'TRANSFER', 'POS', 'CARD_ONLINE', 'COMPLIMENTARY', 'CITY_LEDGER'] as const;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

class TaxComponentDto {
  @IsOptional() @IsBoolean() enabled?: boolean;
  @IsOptional() @IsInt() @Min(0) @Max(5000) rateBps?: number;
  @IsOptional() @IsBoolean() inclusive?: boolean;
}

class ConsumptionTaxDto extends TaxComponentDto {
  @IsOptional() @IsString() @Length(1, 60) label?: string;
}

export class UpdateTaxSettingsDto {
  @IsOptional() @ValidateNested() @Type(() => TaxComponentDto) vat?: TaxComponentDto;
  @IsOptional() @ValidateNested() @Type(() => ConsumptionTaxDto) consumptionTax?: ConsumptionTaxDto;
  @IsOptional() @ValidateNested() @Type(() => TaxComponentDto) serviceCharge?: TaxComponentDto;
  @IsOptional() @IsInt() @Min(0) @Max(10_000) discountApprovalThresholdBps?: number;
}

export class FolioQueryDto extends PaginationQueryDto {
  @IsOptional() @IsIn(['OPEN', 'CLOSED']) status?: 'OPEN' | 'CLOSED';
  @IsOptional() @IsIn(['RESERVATION', 'WALK_IN']) kind?: 'RESERVATION' | 'WALK_IN';
  @IsOptional() @IsString() @MaxLength(80) q?: string;
}

export class CreateFolioDto {
  @IsString() @Length(2, 120) name!: string;
  @IsOptional() @IsUUID() guestId?: string;
  @IsOptional() @IsString() @MaxLength(500) notes?: string;
}

export class AddChargeDto {
  @IsOptional() @IsIn(['EXTRA', 'ROOM', 'DAY_USE']) type?: 'EXTRA' | 'ROOM' | 'DAY_USE';
  @IsString() @Length(2, 160) description!: string;
  /** Per unit, in kobo, as entered (tax-inclusive when a component is inclusive). */
  @IsInt() @Min(1) @Max(MAX_AMOUNT_KOBO) amountKobo!: number;
  @IsOptional() @IsInt() @Min(1) @Max(100) quantity?: number;
  @IsOptional() @IsBoolean() taxable?: boolean;
  @IsOptional() @IsISO8601() clientCreatedAt?: string;
}

class ApprovalDto {
  @IsUUID() approverId!: string;
  @IsString() @Matches(/^\d{4,6}$/, { message: 'pin must be 4 to 6 digits' }) pin!: string;
}

export class AddDiscountDto {
  @IsIn(['AMOUNT', 'PERCENT']) mode!: 'AMOUNT' | 'PERCENT';
  /** Kobo for AMOUNT, basis points for PERCENT (1500 = 15%). */
  @IsInt() @Min(1) @Max(MAX_AMOUNT_KOBO) value!: number;
  @IsOptional() @IsUUID() targetEntryId?: string;
  @IsString() @Length(3, 300) reason!: string;
  @IsOptional() @ValidateNested() @Type(() => ApprovalDto) approval?: ApprovalDto;
}

export class AddPaymentDto {
  @IsIn(METHODS) method!: (typeof METHODS)[number];
  @IsInt() @Min(1) @Max(MAX_AMOUNT_KOBO) amountKobo!: number;
  @IsOptional() @IsString() @MaxLength(120) reference?: string;
  @IsOptional() @IsString() @MaxLength(300) note?: string;
  @IsOptional() @IsISO8601() clientCreatedAt?: string;
}

export class AddRefundDto {
  @IsIn(['CASH', 'TRANSFER', 'POS']) method!: 'CASH' | 'TRANSFER' | 'POS';
  @IsInt() @Min(1) @Max(MAX_AMOUNT_KOBO) amountKobo!: number;
  @IsString() @Length(3, 300) reason!: string;
  @IsOptional() @IsString() @MaxLength(120) reference?: string;
}

export class VoidEntryDto {
  @IsString() @Length(3, 300) reason!: string;
}

export class ProformaDto {
  @IsIn(['PROFORMA']) kind!: 'PROFORMA';
}

export class ShareDto {
  @IsOptional() @IsInt() @Min(1) @Max(720) expiresInHours?: number;
}

export class DocumentQueryDto extends PaginationQueryDto {
  @IsOptional() @Matches(DATE_RE) from?: string;
  @IsOptional() @Matches(DATE_RE) to?: string;
  @IsOptional() @IsString() @MaxLength(80) q?: string;
}

export class InvoiceQueryDto extends DocumentQueryDto {
  @IsOptional() @IsIn(['PROFORMA', 'FINAL']) kind?: 'PROFORMA' | 'FINAL';
}

export class ReceiptQueryDto extends DocumentQueryDto {
  @IsOptional() @IsIn(METHODS) method?: (typeof METHODS)[number];
}
