import { PartialType } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsBoolean,
  IsEmail,
  IsIn,
  IsOptional,
  IsString,
  Length,
  Matches,
  MaxLength,
} from 'class-validator';
import { PaginationQueryDto } from '../../common/utils/pagination.dto.js';

export const ID_TYPES = ['NIN', 'PASSPORT', 'DRIVERS_LICENSE', 'VOTERS_CARD', 'OTHER'] as const;
export const GENDERS = ['MALE', 'FEMALE', 'UNDISCLOSED'] as const;
export const PURPOSES = ['BUSINESS', 'LEISURE', 'EVENT', 'TRANSIT', 'OTHER'] as const;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export class GuestInputDto {
  @IsString() @Length(2, 120) fullName!: string;
  /** Nigerian formats accepted (0803..., +234...); foreign numbers need +country code. */
  @IsString() @Length(7, 24) phone!: string;
  @IsOptional() @IsEmail() @MaxLength(160) email?: string;
  @IsOptional() @IsIn(GENDERS) gender?: (typeof GENDERS)[number];
  @IsOptional() @Matches(DATE_RE, { message: 'dateOfBirth must be YYYY-MM-DD' }) dateOfBirth?: string;
  @IsOptional() @IsString() @Length(2, 60) nationality?: string;
  @IsOptional() @IsString() @MaxLength(300) address?: string;
  @IsOptional() @IsIn(ID_TYPES) idType?: (typeof ID_TYPES)[number];
  @IsOptional() @IsString() @Length(4, 40) idNumber?: string;
  @IsOptional() @IsString() @MaxLength(20) vehiclePlate?: string;
  @IsOptional() @IsString() @MaxLength(120) company?: string;
  @IsOptional() @IsBoolean() vip?: boolean;
  @IsOptional() @IsString() @MaxLength(1000) notes?: string;
  @IsOptional() @IsBoolean() consent?: boolean;
  @IsOptional() @IsBoolean() marketingOptIn?: boolean;
}

export class GuestUpdateDto extends PartialType(GuestInputDto) {}

export class GuestQueryDto extends PaginationQueryDto {
  @IsOptional() @IsString() @MaxLength(80) q?: string;
  @IsOptional() @Type(() => String) @IsIn(['true', 'false']) vip?: 'true' | 'false';
}

export class GuestLookupDto {
  @IsString() @Length(7, 24) phone!: string;
}

export class AnonymiseDto {
  @IsString() @Length(3, 300) reason!: string;
}

export class RegisterQueryDto {
  @Matches(DATE_RE) from!: string;
  @Matches(DATE_RE) to!: string;
  @IsOptional() @IsIn(['json', 'csv']) format?: 'json' | 'csv';
  @IsOptional() @IsIn(['true', 'false']) includeIdNumbers?: 'true' | 'false';
}
