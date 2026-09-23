import { Transform, Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsEmail,
  IsNotEmpty,
  IsOptional,
  IsString,
  IsUrl,
  Matches,
  MaxLength,
  ValidateIf,
  ValidateNested,
} from 'class-validator';
import { ImageDto } from '../../common/utils/image.dto.js';

const trim = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.trim() : value;
const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;

export class UpdatePropertyDto {
  @IsOptional() @IsString() @IsNotEmpty() @MaxLength(120) @Transform(trim)
  name?: string;

  @IsOptional() @IsString() @MaxLength(200) @Transform(trim)
  tagline?: string;

  @IsOptional() @IsString() @MaxLength(5000)
  description?: string;

  @IsOptional() @IsString() @MaxLength(300) @Transform(trim)
  address?: string;

  @IsOptional() @IsString() @IsNotEmpty() @MaxLength(80) @Transform(trim)
  city?: string;

  @IsOptional() @IsString() @IsNotEmpty() @MaxLength(80) @Transform(trim)
  state?: string;

  @IsOptional() @IsString() @MaxLength(80) @Transform(trim)
  area?: string;

  @IsOptional() @IsString() @MaxLength(30) @Transform(trim)
  phone?: string;

  @IsOptional() @ValidateIf((_o, v) => v !== '') @IsEmail() @MaxLength(254)
  email?: string;

  @IsOptional() @Matches(TIME, { message: 'checkInTime must be HH:mm' })
  checkInTime?: string;

  @IsOptional() @Matches(TIME, { message: 'checkOutTime must be HH:mm' })
  checkOutTime?: string;

  @IsOptional() @ValidateIf((_o, v) => v !== null) @IsUrl({ require_protocol: true }) @MaxLength(2048)
  coverImageUrl?: string | null;

  @IsOptional() @IsArray() @ArrayMaxSize(30) @ValidateNested({ each: true }) @Type(() => ImageDto)
  images?: ImageDto[];

  @IsOptional() @IsArray() @ArrayMaxSize(60) @IsString({ each: true }) @MaxLength(60, { each: true })
  amenities?: string[];

  @IsOptional() @IsArray() @ArrayMaxSize(30) @IsString({ each: true }) @MaxLength(300, { each: true })
  policies?: string[];

  /** Requires `booking_site_branding`. Hex colour like #B4452A. */
  @IsOptional() @ValidateIf((_o, v) => v !== null)
  @Matches(/^#[0-9a-fA-F]{6}$/, { message: 'accentColor must be a hex colour like #B4452A' })
  accentColor?: string | null;

  /** Requires `booking_site_branding`. */
  @IsOptional() @ValidateIf((_o, v) => v !== null) @IsUrl({ require_protocol: true }) @MaxLength(2048)
  logoUrl?: string | null;

  @IsOptional() @IsBoolean()
  listedOnMarketplace?: boolean;
}

const PREFIX = /^[A-Z0-9]{2,6}$/;
const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** M5: numbering prefix and slug on PATCH /property and /properties/:id. */
export class UpdatePropertyM5Dto extends UpdatePropertyDto {
  @IsOptional() @Matches(PREFIX, { message: 'invoicePrefix must be 2-6 characters A-Z or 0-9' })
  invoicePrefix?: string;

  @IsOptional() @Matches(SLUG, { message: 'slug must be lowercase letters, digits and dashes' }) @MaxLength(60)
  slug?: string;
}

export class CreatePropertyDto {
  @IsString() @IsNotEmpty() @MaxLength(120) @Transform(trim) name!: string;
  @IsString() @IsNotEmpty() @MaxLength(80) @Transform(trim) city!: string;
  @IsString() @IsNotEmpty() @MaxLength(80) @Transform(trim) state!: string;
  @IsOptional() @IsString() @MaxLength(80) @Transform(trim) area?: string;
  @IsOptional() @IsString() @MaxLength(300) @Transform(trim) address?: string;
  @IsOptional() @IsString() @MaxLength(30) @Transform(trim) phone?: string;
  @IsOptional() @ValidateIf((_o, v) => v !== '') @IsEmail() @MaxLength(254) email?: string;
  @IsOptional() @Matches(TIME, { message: 'checkInTime must be HH:mm' }) checkInTime?: string;
  @IsOptional() @Matches(TIME, { message: 'checkOutTime must be HH:mm' }) checkOutTime?: string;
  @IsOptional() @Matches(SLUG, { message: 'slug must be lowercase letters, digits and dashes' }) @MaxLength(60) slug?: string;
  @IsOptional() @Matches(PREFIX, { message: 'invoicePrefix must be 2-6 characters A-Z or 0-9' }) invoicePrefix?: string;
  @IsOptional() @IsString() @MaxLength(200) @Transform(trim) tagline?: string;
  @IsOptional() @IsString() @MaxLength(5000) description?: string;
  @IsOptional() @IsString() @Matches(/^[0-9a-f-]{36}$/i, { message: 'copyFromPropertyId must be a property id' }) copyFromPropertyId?: string;
}

export class CurrentPropertyDto {
  @IsString() @Matches(/^[0-9a-f-]{36}$/i, { message: 'propertyId must be a property id' }) propertyId!: string;
}

export class PropertyAccessDto {
  @IsBoolean() allProperties!: boolean;
  @IsOptional() @IsArray() @ArrayMaxSize(200) @IsString({ each: true }) propertyIds?: string[];
}
