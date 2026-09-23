import { Transform, Type } from 'class-transformer';
import { ArrayMaxSize, IsArray, IsBoolean, IsIn, IsInt, IsOptional, IsString, IsUUID, Matches, Max, MaxLength, Min, MinLength, ValidateNested } from 'class-validator';
import { PaginationQueryDto } from '../../common/utils/pagination.dto.js';
import type { WhatsAppTemplateName } from '../whatsapp/templates.registry.js';

const bool = ({ value }: { value: unknown }) => (value === 'true' || value === true ? true : value === 'false' || value === false ? false : value);
const PRIORITIES = ['LOW', 'NORMAL', 'HIGH', 'URGENT'] as const;

export class ConversationsQueryDto extends PaginationQueryDto {
  @IsOptional() @IsString() @MaxLength(40) status?: string;
  @IsOptional() @IsUUID() assigneeId?: string;
  @IsOptional() @Transform(bool) @IsBoolean() mine?: boolean;
  @IsOptional() @Transform(bool) @IsBoolean() unread?: boolean;
  @IsOptional() @IsString() @MaxLength(100) q?: string;
}

export class DetailQueryDto {
  @IsOptional() @IsUUID() before?: string;
}

export class TemplateDto {
  @IsString() @MaxLength(60) name!: WhatsAppTemplateName;
  @IsArray() @ArrayMaxSize(20) @IsString({ each: true }) @MaxLength(1000, { each: true }) params!: string[];
}

export class StartConversationDto {
  @IsOptional() @IsUUID() guestId?: string;
  @IsOptional() @IsString() @Matches(/^\+?[0-9 ()-]{10,20}$/) phone?: string;
  @IsOptional() @IsUUID() reservationId?: string;
  @ValidateNested() @Type(() => TemplateDto) template!: TemplateDto;
}

export class ReplyDto {
  @IsOptional() @IsString() @MinLength(1) @MaxLength(4096) body?: string;
  @IsOptional() @IsUUID() quickReplyId?: string;
}

export class NoteDto {
  @IsString() @MinLength(1) @MaxLength(4096) body!: string;
}

export class PatchConversationDto {
  @IsOptional() @IsIn(['OPEN', 'PENDING', 'CLOSED']) status?: 'OPEN' | 'PENDING' | 'CLOSED';
  @IsOptional() @IsUUID() assigneeId?: string | null;
  @IsOptional() @IsUUID() reservationId?: string | null;
  @IsOptional() @IsString() @MaxLength(2000) notes?: string;
}

export class AcceptSuggestionDto {
  @IsOptional() @IsUUID() roomId?: string;
  @IsOptional() @IsIn(PRIORITIES) priority?: (typeof PRIORITIES)[number];
  @IsOptional() @IsString() @MaxLength(500) note?: string;
}

export class QuickReplyDto {
  @IsString() @MinLength(1) @MaxLength(80) title!: string;
  @IsOptional() @IsString() @MaxLength(30) shortcut?: string;
  @IsString() @MinLength(1) @MaxLength(4096) body!: string;
  @IsOptional() @IsInt() @Min(0) @Max(1000) sortOrder?: number;
}

export class UpdateQuickReplyDto {
  @IsOptional() @IsString() @MinLength(1) @MaxLength(80) title?: string;
  @IsOptional() @IsString() @MaxLength(30) shortcut?: string;
  @IsOptional() @IsString() @MinLength(1) @MaxLength(4096) body?: string;
  @IsOptional() @IsInt() @Min(0) @Max(1000) sortOrder?: number;
}

export class InboxSettingsDto {
  @IsOptional() @IsBoolean() enabled?: boolean;
  @IsOptional() @IsString() @MaxLength(80) wifiName?: string;
  @IsOptional() @IsString() @MaxLength(80) wifiPassword?: string;
  @IsOptional() @IsString() @MaxLength(1000) directions?: string;
  @IsOptional() @IsBoolean() preArrivalConfirm?: boolean;
  @IsOptional() @IsBoolean() inStayPrompt?: boolean;
  @IsOptional() @IsBoolean() keywordSuggestions?: boolean;
  @IsOptional() @IsInt() @Min(1) @Max(1440) slaMinutes?: number;
  @IsOptional() @IsString() @MaxLength(40) phoneNumberId?: string | null;
  @IsOptional() @IsString() @Matches(/^\+[1-9][0-9]{7,14}$/, { message: 'whatsappPhone must be in E.164 form, e.g. +2348035550100' }) whatsappPhone?: string | null;
}

export class DevInboundDto {
  @IsString() @Matches(/^\+?[0-9 ()-]{10,20}$/) phone!: string;
  @IsString() @MinLength(1) @MaxLength(4096) body!: string;
  @IsOptional() @IsString() @MaxLength(120) name?: string;
}
