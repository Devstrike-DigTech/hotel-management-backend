import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsBooleanString,
  IsEmail,
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
  ValidateIf,
  ValidateNested,
} from 'class-validator';
import { CATEGORY_CODES, CONTACT_PREFERENCES, LOCATIONS, PRICINGS, SERVICE_CHANNELS, STATUSES } from './concierge.logic.js';

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
const nullable = () => ValidateIf((_o, v) => v !== null);

// ---------------------------------------------------------------------------
// Settings and AUP
// ---------------------------------------------------------------------------

export class AcceptAupDto {
  @IsString() @MaxLength(40) version!: string;
}

class SlaDto {
  @IsOptional() @IsInt() @Min(5) @Max(240) inStayMinutes?: number;
  @IsOptional() @IsInt() @Min(15) @Max(2880) preArrivalMinutes?: number;
  @IsOptional() @IsInt() @Min(0) @Max(240) escalateAfterMinutes?: number;
}

class FolioLabelsDto {
  @IsOptional() @IsString() @Length(3, 60) inRoom?: string;
  @IsOptional() @IsString() @Length(3, 60) other?: string;
}

class VendorSharingDto {
  @IsOptional() @IsBoolean() guestSurname?: boolean;
  @IsOptional() @IsBoolean() roomNumber?: boolean;
}

class PaymentsDto {
  @IsOptional() @IsBoolean() online?: boolean;
  @IsOptional() @IsBoolean() folio?: boolean;
}

export class SettingsDto {
  @IsOptional() @IsBoolean() enabled?: boolean;
  @IsOptional() @ValidateNested() @Type(() => SlaDto) sla?: SlaDto;
  @IsOptional() @ValidateNested() @Type(() => FolioLabelsDto) folioLabels?: FolioLabelsDto;
  @IsOptional() @IsInt() @Min(7) @Max(3650) redactAfterDays?: number;
  @IsOptional() @IsIn(['MASKED', 'HIDDEN']) discreetVisibility?: 'MASKED' | 'HIDDEN';
  @IsOptional() @ValidateNested() @Type(() => VendorSharingDto) vendorSharing?: VendorSharingDto;
  @IsOptional() @ValidateNested() @Type(() => PaymentsDto) payments?: PaymentsDto;
  @IsOptional() @IsBoolean() freeFormEnabled?: boolean;
  @IsOptional() @IsInt() @Min(1) @Max(168) quoteValidityHours?: number;
  @IsOptional() @nullable() @IsString() @MaxLength(300) intro?: string | null;
}

export class ScreenDto {
  @IsArray() @ArrayMaxSize(50) @IsString({ each: true }) @MaxLength(4000, { each: true }) texts!: string[];
}

// ---------------------------------------------------------------------------
// Services
// ---------------------------------------------------------------------------

export class AvailabilityDto {
  @IsArray() @ArrayMinSize(1) @ArrayMaxSize(7) @IsInt({ each: true }) @Min(0, { each: true }) @Max(6, { each: true }) days!: number[];
  @Matches(TIME_RE) from!: string;
  @Matches(TIME_RE) to!: string;
}

export class VariantDto {
  @IsOptional() @IsString() @MaxLength(40) id?: string;
  @IsString() @Length(1, 60) name!: string;
  @IsInt() @Min(0) @Max(1_000_000_000) priceKobo!: number;
  @IsOptional() @nullable() @IsInt() @Min(15) @Max(1440) durationMinutes?: number | null;
}

class ServiceFieldsDto {
  @IsOptional() @IsString() @MaxLength(600) description?: string;
  @IsOptional() @nullable() @IsString() @MaxLength(500) imageUrl?: string | null;
  @IsOptional() @nullable() @IsInt() @Min(0) @Max(1_000_000_000) priceKobo?: number | null;
  @IsOptional() @IsArray() @ArrayMaxSize(10) @ValidateNested({ each: true }) @Type(() => VariantDto) variants?: VariantDto[];
  @IsOptional() @nullable() @IsInt() @Min(15) @Max(1440) durationMinutes?: number | null;
  @IsOptional() @IsInt() @Min(0) @Max(168) leadTimeHours?: number;
  @IsOptional() @nullable() @ValidateNested() @Type(() => AvailabilityDto) availability?: AvailabilityDto | null;
  @IsOptional() @IsBoolean() requiresSlot?: boolean;
  @IsOptional() @nullable() @IsInt() @Min(1) @Max(100) slotCapacity?: number | null;
  @IsOptional() @IsIn(LOCATIONS) location?: string;
  @IsOptional() @IsIn(['STAFF', 'VENDOR']) fulfilledBy?: string;
  @IsOptional() @nullable() @IsUUID() vendorId?: string | null;
  @IsOptional() @IsBoolean() discreetEligible?: boolean;
  @IsOptional() @IsArray() @ArrayMaxSize(20) @IsObject({ each: true }) questions?: Record<string, unknown>[];
  @IsOptional() @IsBoolean() taxable?: boolean;
  @IsOptional() @IsArray() @ArrayMinSize(1) @IsIn(SERVICE_CHANNELS, { each: true }) channels?: string[];
  @IsOptional() @IsBoolean() active?: boolean;
  @IsOptional() @IsInt() @Min(0) @Max(1000) sortOrder?: number;
}

export class CreateServiceDto extends ServiceFieldsDto {
  @IsString() @Length(2, 80) name!: string;
  @IsIn(CATEGORY_CODES) category!: string;
  @IsIn(PRICINGS) pricing!: string;
}

export class UpdateServiceDto extends ServiceFieldsDto {
  @IsOptional() @IsString() @Length(2, 80) name?: string;
  @IsOptional() @IsIn(CATEGORY_CODES) category?: string;
  @IsOptional() @IsIn(PRICINGS) pricing?: string;
}

export class ServiceQueryDto {
  @IsOptional() @IsBooleanString() active?: string;
  @IsOptional() @IsIn(CATEGORY_CODES) category?: string;
  @IsOptional() @IsIn(['LIVE', 'PENDING_REVIEW', 'REJECTED', 'HIDDEN']) reviewStatus?: string;
}

export class SlotsQueryDto {
  @IsOptional() @Matches(DATE_RE) date?: string;
  @IsOptional() @IsString() @MaxLength(40) variantId?: string;
}

export class PriceDto {
  @IsUUID() serviceId!: string;
  @IsOptional() @IsString() @MaxLength(40) variantId?: string;
  @IsOptional() @IsInt() @Min(1) @Max(50) partySize?: number;
  @IsOptional() @IsInt() @Min(1) @Max(24) hours?: number;
  @IsOptional() @IsIn(SERVICE_CHANNELS) channel?: string;
}

// ---------------------------------------------------------------------------
// Vendors
// ---------------------------------------------------------------------------

class VendorFieldsDto {
  @IsOptional() @nullable() @IsString() @MaxLength(120) contactName?: string | null;
  @IsOptional() @nullable() @IsString() @MaxLength(30) phone?: string | null;
  @IsOptional() @nullable() @IsString() @MaxLength(30) whatsapp?: string | null;
  @IsOptional() @nullable() @IsEmail() @MaxLength(200) email?: string | null;
  @IsOptional() @IsIn(['NONE', 'PERCENT', 'FIXED']) commissionType?: 'NONE' | 'PERCENT' | 'FIXED';
  @IsOptional() @IsInt() @Min(0) @Max(100_000_000) commissionValue?: number;
  @IsOptional() @nullable() @IsString() @MaxLength(500) payoutNotes?: string | null;
  @IsOptional() @nullable() @IsString() @MaxLength(1000) notes?: string | null;
  @IsOptional() @IsBoolean() active?: boolean;
}

export class CreateVendorDto extends VendorFieldsDto {
  @IsString() @Length(2, 120) name!: string;
  @IsIn(CATEGORY_CODES) category!: string;
}

export class UpdateVendorDto extends VendorFieldsDto {
  @IsOptional() @IsString() @Length(2, 120) name?: string;
  @IsOptional() @IsIn(CATEGORY_CODES) category?: string;
}

export class VendorQueryDto {
  @IsOptional() @IsBooleanString() active?: string;
  @IsOptional() @IsIn(CATEGORY_CODES) category?: string;
}

export class SettleDto {
  @IsOptional() @IsArray() @ArrayMaxSize(500) @IsUUID('all', { each: true }) requestIds?: string[];
  @IsOptional() @Matches(DATE_RE) upTo?: string;
  @IsOptional() @IsString() @MaxLength(120) reference?: string;
}

// ---------------------------------------------------------------------------
// Requests
// ---------------------------------------------------------------------------

export class RequestQueryDto {
  @IsOptional() @IsString() @MaxLength(200) status?: string;
  @IsOptional() @IsIn(['BOOKING_FLOW', 'TRIP_PAGE', 'WHATSAPP', 'FRONT_DESK']) source?: string;
  @IsOptional() @Matches(DATE_RE) from?: string;
  @IsOptional() @Matches(DATE_RE) to?: string;
  @IsOptional() @IsString() @MaxLength(100) q?: string;
  @IsOptional() @IsUUID() assigneeId?: string;
  @IsOptional() @IsUUID() vendorId?: string;
  @IsOptional() @IsUUID() serviceId?: string;
  @IsOptional() @IsUUID() reservationId?: string;
  @IsOptional() @IsBooleanString() discreet?: string;
  @IsOptional() @IsBooleanString() flagged?: string;
  @IsOptional() @IsBooleanString() overdue?: string;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) page?: number;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(100) pageSize?: number;
}

export class StaffCreateRequestDto {
  @IsOptional() @IsUUID() reservationId?: string;
  @IsOptional() @IsUUID() guestId?: string;
  @IsOptional() @IsUUID() serviceId?: string;
  @IsOptional() @IsString() @MaxLength(40) variantId?: string;
  @IsOptional() @IsString() @Length(1, 1000) requestText?: string;
  @IsOptional() @IsObject() answers?: Record<string, unknown>;
  @IsOptional() @IsISO8601() preferredStart?: string;
  @IsOptional() @IsISO8601() preferredEnd?: string;
  @IsOptional() @IsInt() @Min(1) @Max(24) hours?: number;
  @IsOptional() @IsInt() @Min(1) @Max(50) partySize?: number;
  @IsOptional() @IsString() @MaxLength(1000) notes?: string;
  @IsOptional() @IsString() @MaxLength(1000) internalNotes?: string;
  @IsOptional() @IsBoolean() discreet?: boolean;
  @IsOptional() @IsIn(CONTACT_PREFERENCES) contactPreference?: string;
  @IsOptional() @IsIn(['ONLINE', 'FOLIO', 'NONE']) paymentMethod?: 'ONLINE' | 'FOLIO' | 'NONE';
  @IsOptional() @IsBoolean() notifyGuest?: boolean;
  @IsOptional() @IsUUID() assigneeId?: string;
  @IsOptional() @IsUUID() vendorId?: string;
  @IsOptional() @IsISO8601() clientCreatedAt?: string;
}

export class FromMessageDto {
  @IsUUID() conversationId!: string;
  @IsOptional() @IsUUID() messageId?: string;
  @IsOptional() @IsUUID() serviceId?: string;
  @IsOptional() @IsString() @MaxLength(40) variantId?: string;
  @IsOptional() @IsBoolean() discreet?: boolean;
  @IsOptional() @IsString() @MaxLength(1000) notes?: string;
}

export class UpdateRequestDto {
  @IsOptional() @nullable() @IsISO8601() preferredStart?: string | null;
  @IsOptional() @nullable() @IsISO8601() preferredEnd?: string | null;
  @IsOptional() @nullable() @IsInt() @Min(1) @Max(50) partySize?: number | null;
  @IsOptional() @nullable() @IsInt() @Min(1) @Max(24) hours?: number | null;
  @IsOptional() @nullable() @IsString() @MaxLength(1000) notes?: string | null;
  @IsOptional() @nullable() @IsString() @MaxLength(1000) internalNotes?: string | null;
  @IsOptional() @IsIn(CONTACT_PREFERENCES) contactPreference?: string;
  @IsOptional() @IsBoolean() discreet?: boolean;
}

export class QuoteDto {
  @IsInt() @Min(1) @Max(1_000_000_000) amountKobo!: number;
  @IsOptional() @IsBoolean() taxable?: boolean;
  @IsOptional() @IsInt() @Min(1) @Max(168) validHours?: number;
  @IsOptional() @IsISO8601() validUntil?: string;
  @IsOptional() @IsString() @MaxLength(500) note?: string;
  @IsOptional() @IsBoolean() notify?: boolean;
}

export class ConfirmDto {
  @IsIn(['ONLINE', 'FOLIO', 'NONE']) paymentMethod!: 'ONLINE' | 'FOLIO' | 'NONE';
  @IsOptional() @IsString() @MaxLength(300) note?: string;
}

export class AssignDto {
  @IsOptional() @nullable() @IsUUID() assigneeId?: string | null;
  @IsOptional() @nullable() @IsUUID() vendorId?: string | null;
}

export class SendToVendorDto {
  @IsOptional() @IsIn(['WHATSAPP', 'SMS']) channel?: 'WHATSAPP' | 'SMS';
  @IsOptional() @IsString() @MaxLength(300) note?: string;
  @IsOptional() @IsBoolean() includeGuestSurname?: boolean;
  @IsOptional() @IsBoolean() includeRoom?: boolean;
}

export class StatusDto {
  @IsIn(STATUSES.filter((s) => s !== 'NEW' && s !== 'QUOTED' && s !== 'AWAITING_GUEST')) status!: 'CONFIRMED' | 'SCHEDULED' | 'IN_PROGRESS' | 'COMPLETED' | 'DECLINED' | 'CANCELLED';
  @IsOptional() @IsString() @MaxLength(500) note?: string;
  @IsOptional() @IsISO8601() scheduledAt?: string;
  @IsOptional() @IsBoolean() notifyGuest?: boolean;
  @IsOptional() @IsInt() @Min(1) @Max(5) vendorRating?: number;
  @IsOptional() @IsISO8601() clientCreatedAt?: string;
}

export class NoteDto {
  @IsString() @Length(1, 500) note!: string;
}

export class FlagReviewDto {
  @IsIn(['CLEAR', 'DECLINE']) decision!: 'CLEAR' | 'DECLINE';
  @IsString() @Length(1, 500) note!: string;
}

export class RateVendorDto {
  @IsInt() @Min(1) @Max(5) rating!: number;
}

export class ExportQueryDto {
  @Matches(DATE_RE) from!: string;
  @Matches(DATE_RE) to!: string;
  @IsOptional() @IsIn(['csv', 'json']) format?: 'csv' | 'json';
}

export class ReportQueryDto {
  @IsOptional() @Matches(DATE_RE) from?: string;
  @IsOptional() @Matches(DATE_RE) to?: string;
}

// ---------------------------------------------------------------------------
// Public
// ---------------------------------------------------------------------------

export class PublicCatalogueQueryDto {
  @IsOptional() @IsIn(['BOOKING_FLOW', 'TRIP_PAGE']) channel?: 'BOOKING_FLOW' | 'TRIP_PAGE';
  @IsOptional() @IsIn(CATEGORY_CODES) category?: string;
}

export class PublicPriceDto {
  @IsUUID() serviceId!: string;
  @IsOptional() @IsString() @MaxLength(40) variantId?: string;
  @IsOptional() @IsInt() @Min(1) @Max(50) partySize?: number;
  @IsOptional() @IsInt() @Min(1) @Max(24) hours?: number;
}

export class GuestCreateRequestDto {
  @IsOptional() @IsUUID() serviceId?: string;
  @IsOptional() @IsString() @MaxLength(40) variantId?: string;
  @IsOptional() @IsString() @MaxLength(1000) requestText?: string;
  @IsOptional() @IsObject() answers?: Record<string, unknown>;
  @IsOptional() @IsISO8601() preferredStart?: string;
  @IsOptional() @IsISO8601() preferredEnd?: string;
  @IsOptional() @IsInt() @Min(1) @Max(24) hours?: number;
  @IsOptional() @IsInt() @Min(1) @Max(50) partySize?: number;
  @IsOptional() @IsString() @MaxLength(1000) notes?: string;
  @IsOptional() @IsBoolean() discreet?: boolean;
  @IsIn(CONTACT_PREFERENCES) contactPreference!: 'WHATSAPP' | 'SMS' | 'EMAIL' | 'IN_APP';
  @IsOptional() @IsString() @MaxLength(30) contactPhone?: string;
  @IsOptional() @IsEmail() @MaxLength(200) contactEmail?: string;
  @IsOptional() @IsIn(['ONLINE', 'FOLIO']) paymentMethod?: 'ONLINE' | 'FOLIO';
  @IsOptional() @IsIn(['BOOKING_FLOW', 'TRIP_PAGE']) source?: 'BOOKING_FLOW' | 'TRIP_PAGE';
}

export class GuestCancelDto {
  @IsOptional() @IsString() @MaxLength(300) reason?: string;
}

export class GuestRateDto {
  @IsInt() @Min(1) @Max(5) rating!: number;
  @IsOptional() @IsString() @MaxLength(1000) comment?: string;
}

export class AcceptQuoteDto {
  @IsIn(['ONLINE', 'FOLIO']) paymentMethod!: 'ONLINE' | 'FOLIO';
  @IsOptional() @IsEmail() @MaxLength(200) email?: string;
}

export class DeclineQuoteDto {
  @IsOptional() @IsString() @MaxLength(300) reason?: string;
}

// ---------------------------------------------------------------------------
// Platform
// ---------------------------------------------------------------------------

export class ReviewQueryDto {
  @IsOptional() @IsIn(['PENDING_REVIEW', 'REJECTED', 'HIDDEN', 'LIVE']) status?: 'PENDING_REVIEW' | 'REJECTED' | 'HIDDEN' | 'LIVE';
  @IsOptional() @IsUUID() tenantId?: string;
  @IsOptional() @IsString() @MaxLength(100) q?: string;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) page?: number;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(100) pageSize?: number;
}

export class ApproveDto {
  @IsOptional() @IsString() @MaxLength(500) note?: string;
}

export class ReasonDto {
  @IsString() @Length(5, 500) reason!: string;
}

export class TenantQueryDto {
  @IsOptional() @IsBooleanString() suspended?: string;
  @IsOptional() @IsString() @MaxLength(100) q?: string;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) page?: number;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(100) pageSize?: number;
}

export class ReinstateDto {
  @IsOptional() @IsString() @MaxLength(500) note?: string;
}
