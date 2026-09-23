import { Transform, Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
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

const trim = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value);
const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
export const OUTLET_TYPES = ['RESTAURANT', 'BAR', 'POOL_BAR', 'ROOM_SERVICE', 'MINIBAR', 'LAUNDRY', 'SPA', 'OTHER'] as const;
export const STATIONS = ['KITCHEN', 'BAR', 'NONE'] as const;
export const TENDERS = ['CASH', 'TRANSFER', 'POS'] as const;

export class ApprovalDto {
  @IsUUID() approverId!: string;
  @IsString() @Matches(/^\d{4,6}$/, { message: 'pin must be 4-6 digits' }) pin!: string;
}

// ----- outlets, categories, items, happy hours -----

export class CreateOutletDto {
  @IsString() @Length(2, 80) @Transform(trim) name!: string;
  @Matches(/^[A-Z]{2,6}$/, { message: 'code must be 2-6 capital letters' }) code!: string;
  @IsIn(OUTLET_TYPES) type!: (typeof OUTLET_TYPES)[number];
  @IsOptional() @IsIn(STATIONS) defaultStation?: (typeof STATIONS)[number];
  @IsOptional() @IsBoolean() serviceChargeApplies?: boolean;
  @IsOptional() @IsBoolean() allowRoomCharge?: boolean;
  @IsOptional() @IsBoolean() allowCityLedger?: boolean;
  @IsOptional() @IsBoolean() active?: boolean;
  @IsOptional() @IsInt() @Min(0) @Max(1000) sortOrder?: number;
}

export class UpdateOutletDto {
  @IsOptional() @IsString() @Length(2, 80) @Transform(trim) name?: string;
  @IsOptional() @Matches(/^[A-Z]{2,6}$/, { message: 'code must be 2-6 capital letters' }) code?: string;
  @IsOptional() @IsIn(OUTLET_TYPES) type?: (typeof OUTLET_TYPES)[number];
  @IsOptional() @IsIn(STATIONS) defaultStation?: (typeof STATIONS)[number];
  @IsOptional() @IsBoolean() serviceChargeApplies?: boolean;
  @IsOptional() @IsBoolean() allowRoomCharge?: boolean;
  @IsOptional() @IsBoolean() allowCityLedger?: boolean;
  @IsOptional() @IsBoolean() active?: boolean;
  @IsOptional() @IsInt() @Min(0) @Max(1000) sortOrder?: number;
}

export class CategoryDto {
  @IsString() @Length(1, 60) @Transform(trim) name!: string;
  @IsOptional() @IsIn(STATIONS) station?: (typeof STATIONS)[number] | null;
  @IsOptional() @IsInt() @Min(0) @Max(1000) sortOrder?: number;
}

export class UpdateCategoryDto {
  @IsOptional() @IsString() @Length(1, 60) @Transform(trim) name?: string;
  @IsOptional() @IsIn([...STATIONS, null]) station?: (typeof STATIONS)[number] | null;
  @IsOptional() @IsInt() @Min(0) @Max(1000) sortOrder?: number;
}

export class ModifierOptionDto {
  @IsOptional() @IsString() @MaxLength(40) id?: string;
  @IsString() @Length(1, 60) @Transform(trim) name!: string;
  @IsInt() @Min(0) @Max(100_000_000) priceKobo!: number;
}

export class ModifierGroupDto {
  @IsOptional() @IsString() @MaxLength(40) id?: string;
  @IsString() @Length(1, 60) @Transform(trim) name!: string;
  @IsBoolean() required!: boolean;
  @IsBoolean() multiple!: boolean;
  @IsArray() @ArrayMinSize(1) @ArrayMaxSize(30) @ValidateNested({ each: true }) @Type(() => ModifierOptionDto) options!: ModifierOptionDto[];
}

export class StockLinkDto {
  @IsUUID() stockItemId!: string;
  @Type(() => Number) @Min(0.001) @Max(1000) quantity!: number;
}

export class CreateItemDto {
  @IsUUID() categoryId!: string;
  @IsString() @Length(1, 100) @Transform(trim) name!: string;
  @IsOptional() @IsString() @MaxLength(500) description?: string;
  @IsInt() @Min(0) @Max(100_000_000) priceKobo!: number;
  @IsOptional() @IsArray() @IsUUID('all', { each: true }) outletIds?: string[];
  @IsOptional() @IsBoolean() available?: boolean;
  @IsOptional() @IsBoolean() vat?: boolean;
  @IsOptional() @IsBoolean() consumptionTax?: boolean;
  @IsOptional() @IsArray() @ArrayMaxSize(10) @ValidateNested({ each: true }) @Type(() => ModifierGroupDto) modifiers?: ModifierGroupDto[];
  @IsOptional() @IsIn([...STATIONS, null]) station?: (typeof STATIONS)[number] | null;
  @IsOptional() @IsArray() @ArrayMaxSize(10) @ValidateNested({ each: true }) @Type(() => StockLinkDto) stockLinks?: StockLinkDto[];
  @IsOptional() @IsString() @MaxLength(2048) imageUrl?: string | null;
  @IsOptional() @IsInt() @Min(0) @Max(10000) sortOrder?: number;
}

export class UpdateItemDto {
  @IsOptional() @IsUUID() categoryId?: string;
  @IsOptional() @IsString() @Length(1, 100) @Transform(trim) name?: string;
  @IsOptional() @IsString() @MaxLength(500) description?: string;
  @IsOptional() @IsInt() @Min(0) @Max(100_000_000) priceKobo?: number;
  @IsOptional() @IsArray() @IsUUID('all', { each: true }) outletIds?: string[];
  @IsOptional() @IsBoolean() available?: boolean;
  @IsOptional() @IsBoolean() vat?: boolean;
  @IsOptional() @IsBoolean() consumptionTax?: boolean;
  @IsOptional() @IsArray() @ArrayMaxSize(10) @ValidateNested({ each: true }) @Type(() => ModifierGroupDto) modifiers?: ModifierGroupDto[];
  @IsOptional() @IsIn([...STATIONS, null]) station?: (typeof STATIONS)[number] | null;
  @IsOptional() @IsArray() @ArrayMaxSize(10) @ValidateNested({ each: true }) @Type(() => StockLinkDto) stockLinks?: StockLinkDto[];
  @IsOptional() @IsString() @MaxLength(2048) imageUrl?: string | null;
  @IsOptional() @IsInt() @Min(0) @Max(10000) sortOrder?: number;
}

export class AvailabilityDto {
  @IsBoolean() available!: boolean;
}

export class ItemQueryDto {
  @IsOptional() @IsUUID() outletId?: string;
  @IsOptional() @IsUUID() categoryId?: string;
  @IsOptional() @Transform(({ value }) => value === 'true' || value === true) @IsBoolean() available?: boolean;
  @IsOptional() @IsString() @MaxLength(80) q?: string;
}

export class PriceRuleDto {
  @IsString() @Length(1, 80) @Transform(trim) name!: string;
  @IsOptional() @IsBoolean() active?: boolean;
  @IsOptional() @IsArray() @IsUUID('all', { each: true }) outletIds?: string[];
  @IsOptional() @IsArray() @IsUUID('all', { each: true }) categoryIds?: string[];
  @IsOptional() @IsArray() @IsUUID('all', { each: true }) itemIds?: string[];
  @IsOptional() @IsArray() @IsInt({ each: true }) @Min(0, { each: true }) @Max(6, { each: true }) daysOfWeek?: number[];
  @Matches(TIME, { message: 'startTime must be HH:MM' }) startTime!: string;
  @Matches(TIME, { message: 'endTime must be HH:MM' }) endTime!: string;
  @IsIn(['PERCENT', 'AMOUNT', 'FIXED']) adjustmentType!: 'PERCENT' | 'AMOUNT' | 'FIXED';
  @IsInt() @Min(0) @Max(100_000_000) value!: number;
}

export class UpdatePriceRuleDto {
  @IsOptional() @IsString() @Length(1, 80) @Transform(trim) name?: string;
  @IsOptional() @IsBoolean() active?: boolean;
  @IsOptional() @IsArray() @IsUUID('all', { each: true }) outletIds?: string[];
  @IsOptional() @IsArray() @IsUUID('all', { each: true }) categoryIds?: string[];
  @IsOptional() @IsArray() @IsUUID('all', { each: true }) itemIds?: string[];
  @IsOptional() @IsArray() @IsInt({ each: true }) @Min(0, { each: true }) @Max(6, { each: true }) daysOfWeek?: number[];
  @IsOptional() @Matches(TIME, { message: 'startTime must be HH:MM' }) startTime?: string;
  @IsOptional() @Matches(TIME, { message: 'endTime must be HH:MM' }) endTime?: string;
  @IsOptional() @IsIn(['PERCENT', 'AMOUNT', 'FIXED']) adjustmentType?: 'PERCENT' | 'AMOUNT' | 'FIXED';
  @IsOptional() @IsInt() @Min(0) @Max(100_000_000) value?: number;
}

export class MenuQueryDto {
  @IsUUID() outletId!: string;
}

// ----- orders -----

export class LineInputDto {
  @IsUUID() itemId!: string;
  @IsInt() @Min(1) @Max(99) quantity!: number;
  @IsOptional() @IsArray() @ArrayMaxSize(30) @IsString({ each: true }) modifierOptionIds?: string[];
  @IsOptional() @IsString() @MaxLength(140) note?: string;
}

export class CreateOrderDto {
  @IsOptional() @IsUUID() id?: string;
  @IsUUID() outletId!: string;
  @IsOptional() @IsString() @MaxLength(30) @Transform(trim) tableLabel?: string;
  @IsOptional() @IsUUID() roomId?: string;
  @IsOptional() @IsUUID() reservationId?: string;
  @IsOptional() @IsString() @MaxLength(120) @Transform(trim) guestName?: string;
  @IsOptional() @IsInt() @Min(1) @Max(200) covers?: number;
  @IsOptional() @IsString() @MaxLength(500) notes?: string;
  @IsOptional() @IsArray() @ArrayMaxSize(100) @ValidateNested({ each: true }) @Type(() => LineInputDto) lines?: LineInputDto[];
  @IsOptional() @IsBoolean() send?: boolean;
  @IsOptional() @IsString() clientCreatedAt?: string;
}

export class UpdateOrderDto {
  @IsOptional() @IsString() @MaxLength(30) @Transform(trim) tableLabel?: string;
  @IsOptional() @IsInt() @Min(1) @Max(200) covers?: number;
  @IsOptional() @IsString() @MaxLength(120) @Transform(trim) guestName?: string;
  @IsOptional() @IsString() @MaxLength(500) notes?: string;
  @IsOptional() @IsUUID() roomId?: string;
  @IsOptional() @IsUUID() reservationId?: string;
}

export class AddLinesDto {
  @IsArray() @ArrayMinSize(1) @ArrayMaxSize(100) @ValidateNested({ each: true }) @Type(() => LineInputDto) lines!: LineInputDto[];
  @IsOptional() @IsString() clientCreatedAt?: string;
}

export class UpdateLineDto {
  @IsOptional() @IsInt() @Min(1) @Max(99) quantity?: number;
  @IsOptional() @IsString() @MaxLength(140) note?: string;
}

export class VoidLineDto {
  @IsString() @Length(3, 300) reason!: string;
  @IsOptional() @IsInt() @Min(1) @Max(99) quantity?: number;
  @IsOptional() @IsBoolean() returnToStock?: boolean;
  @IsOptional() @ValidateNested() @Type(() => ApprovalDto) approval?: ApprovalDto;
}

export class OrderDiscountDto {
  @IsIn(['AMOUNT', 'PERCENT']) mode!: 'AMOUNT' | 'PERCENT';
  @IsInt() @Min(1) @Max(100_000_000) value!: number;
  @IsString() @Length(3, 300) reason!: string;
  @IsOptional() @ValidateNested() @Type(() => ApprovalDto) approval?: ApprovalDto;
}

export class SplitLineDto {
  @IsUUID() lineId!: string;
  @IsInt() @Min(1) @Max(99) quantity!: number;
}

export class SplitDto {
  @IsArray() @ArrayMinSize(1) @ArrayMaxSize(100) @ValidateNested({ each: true }) @Type(() => SplitLineDto) lines!: SplitLineDto[];
}

export class CancelOrderDto {
  @IsString() @Length(3, 300) reason!: string;
}

export class TenderDto {
  @IsIn(TENDERS) method!: (typeof TENDERS)[number];
  @IsInt() @Min(1) @Max(100_000_000_000) amountKobo!: number;
  @IsOptional() @IsString() @MaxLength(80) reference?: string;
}

export class OverrideDto {
  @IsString() @Length(3, 300) reason!: string;
}

export class RoomChargeDto {
  @IsUUID() reservationId!: string;
  @IsOptional() @IsString() @MaxLength(120) guestName?: string;
  @IsOptional() @IsString() @MaxLength(12) pin?: string;
  @IsOptional() @IsString() @MaxLength(280_000) @Matches(/^data:image\/png;base64,[A-Za-z0-9+/=]+$/, { message: 'signatureDataUrl must be a PNG data URL' }) signatureDataUrl?: string;
  @IsOptional() @ValidateNested() @Type(() => OverrideDto) override?: OverrideDto;
}

export class CityLedgerSettleDto {
  @IsUUID() corporateAccountId!: string;
  @IsOptional() @IsString() @MaxLength(120) signedBy?: string;
  @IsOptional() @IsString() @MaxLength(80) reference?: string;
}

export class SettleDto {
  @IsOptional() @IsArray() @ArrayMinSize(1) @ArrayMaxSize(10) @ValidateNested({ each: true }) @Type(() => TenderDto) payments?: TenderDto[];
  @IsOptional() @IsInt() @Min(0) @Max(100_000_000) tipKobo?: number;
  @IsOptional() @ValidateNested() @Type(() => RoomChargeDto) roomCharge?: RoomChargeDto;
  @IsOptional() @ValidateNested() @Type(() => CityLedgerSettleDto) cityLedger?: CityLedgerSettleDto;
  @IsOptional() @ValidateNested() @Type(() => OverrideDto) complimentary?: OverrideDto;
  @IsOptional() @IsString() clientCreatedAt?: string;
}

export class OrdersQueryDto extends PaginationQueryDto {
  @IsOptional() @IsString() @MaxLength(60) status?: string;
  @IsOptional() @IsUUID() outletId?: string;
  @IsOptional() @Matches(DATE) date?: string;
  @IsOptional() @IsString() @MaxLength(80) q?: string;
}

export class InHouseQueryDto {
  @IsOptional() @IsString() @MaxLength(80) q?: string;
}

// ----- KDS -----

export class KdsQueryDto {
  @IsOptional() @IsIn(['KITCHEN', 'BAR']) station?: 'KITCHEN' | 'BAR';
  @IsOptional() @IsUUID() outletId?: string;
  @IsOptional() @IsString() @MaxLength(80) status?: string;
  @IsOptional() @IsString() @MaxLength(40) since?: string;
}

export class KdsStatusDto {
  @IsIn(['NEW', 'PREPARING', 'READY', 'SERVED']) status!: 'NEW' | 'PREPARING' | 'READY' | 'SERVED';
}

// ----- stock and minibar -----

export class StockItemDto {
  @IsString() @Length(1, 100) @Transform(trim) name!: string;
  @IsString() @Length(1, 30) unit!: string;
  @IsOptional() @IsString() @MaxLength(60) category?: string;
  @IsOptional() @IsString() @MaxLength(60) sku?: string;
  @IsOptional() @Type(() => Number) @Min(0) reorderLevel?: number;
  @IsOptional() @Type(() => Number) @Min(0) parLevel?: number;
  @IsOptional() @IsInt() @Min(0) unitCostKobo?: number;
  @IsOptional() @Type(() => Number) @Min(0) openingQuantity?: number;
}

export class UpdateStockItemDto {
  @IsOptional() @IsString() @Length(1, 100) @Transform(trim) name?: string;
  @IsOptional() @IsString() @Length(1, 30) unit?: string;
  @IsOptional() @IsString() @MaxLength(60) category?: string;
  @IsOptional() @IsString() @MaxLength(60) sku?: string;
  @IsOptional() @Type(() => Number) @Min(0) reorderLevel?: number;
  @IsOptional() @Type(() => Number) @Min(0) parLevel?: number | null;
  @IsOptional() @IsInt() @Min(0) unitCostKobo?: number;
  @IsOptional() @IsBoolean() active?: boolean;
}

export class StockQueryDto {
  @IsOptional() @IsString() @MaxLength(80) q?: string;
  @IsOptional() @Transform(({ value }) => value === 'true' || value === true) @IsBoolean() lowStock?: boolean;
  @IsOptional() @IsString() @MaxLength(60) category?: string;
}

export class PurchaseLineDto {
  @IsUUID() stockItemId!: string;
  @Type(() => Number) @Min(0.001) quantity!: number;
  @IsInt() @Min(0) unitCostKobo!: number;
}

export class PurchaseDto {
  @IsOptional() @IsString() @MaxLength(120) supplier?: string;
  @IsOptional() @IsString() @MaxLength(80) reference?: string;
  @IsArray() @ArrayMinSize(1) @ArrayMaxSize(200) @ValidateNested({ each: true }) @Type(() => PurchaseLineDto) lines!: PurchaseLineDto[];
}

export class AdjustmentDto {
  @IsUUID() stockItemId!: string;
  @Type(() => Number) quantity!: number;
  @IsIn(['WASTE', 'ADJUSTMENT']) type!: 'WASTE' | 'ADJUSTMENT';
  @IsString() @Length(3, 300) note!: string;
}

export class CountLineDto {
  @IsUUID() stockItemId!: string;
  @Type(() => Number) @Min(0) counted!: number;
}

export class CountDto {
  @IsOptional() @IsString() @MaxLength(300) note?: string;
  @IsArray() @ArrayMinSize(1) @ArrayMaxSize(500) @ValidateNested({ each: true }) @Type(() => CountLineDto) lines!: CountLineDto[];
}

export class MovementsQueryDto extends PaginationQueryDto {
  @IsOptional() @IsUUID() stockItemId?: string;
  @IsOptional() @IsString() @MaxLength(20) type?: string;
  @IsOptional() @Matches(DATE) from?: string;
  @IsOptional() @Matches(DATE) to?: string;
}

export class RangeDto {
  @Matches(DATE) from!: string;
  @Matches(DATE) to!: string;
  @IsOptional() @IsUUID() outletId?: string;
}

export class MinibarParItemDto {
  @IsUUID() itemId!: string;
  @IsInt() @Min(0) @Max(50) parQty!: number;
}

export class MinibarParDto {
  @IsUUID() roomTypeId!: string;
  @IsArray() @ArrayMaxSize(60) @ValidateNested({ each: true }) @Type(() => MinibarParItemDto) items!: MinibarParItemDto[];
}

export class MinibarParQueryDto {
  @IsOptional() @IsUUID() roomTypeId?: string;
}

export class MinibarUseItemDto {
  @IsUUID() itemId!: string;
  @IsInt() @Min(1) @Max(50) quantity!: number;
}

export class MinibarConsumptionDto {
  @IsUUID() roomId!: string;
  @IsArray() @ArrayMinSize(1) @ArrayMaxSize(60) @ValidateNested({ each: true }) @Type(() => MinibarUseItemDto) items!: MinibarUseItemDto[];
  @IsOptional() @IsString() @MaxLength(300) note?: string;
  @IsOptional() @IsUUID() housekeepingTaskId?: string;
  @IsOptional() @IsString() clientCreatedAt?: string;
}
