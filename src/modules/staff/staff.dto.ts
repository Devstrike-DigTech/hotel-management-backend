import { Transform } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsEmail,
  IsEnum,
  IsNotEmpty,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
} from 'class-validator';
import { StaffRole } from '../../generated/prisma/enums.js';
import {
  PASSWORD_MESSAGE,
  PASSWORD_RULE,
  PHONE_RULE,
} from '../auth/auth.dto.js';

const trim = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.trim() : value;
const lowerTrim = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.trim().toLowerCase() : value;

export class CreateStaffDto {
  @IsString() @IsNotEmpty() @MaxLength(120) @Transform(trim)
  fullName!: string;

  @IsEmail() @MaxLength(254) @Transform(lowerTrim)
  email!: string;

  @IsString() @Matches(PHONE_RULE, { message: 'phone must be a valid phone number' }) @Transform(trim)
  phone!: string;

  /** Legacy: a system role key. Use `roleId` for custom roles. */
  @IsOptional() @IsEnum(StaffRole)
  role?: StaffRole;

  /** System role key ("FRONT_DESK") or custom role id. */
  @IsOptional() @IsString() @MaxLength(60)
  roleId?: string;

  @IsString() @Matches(PASSWORD_RULE, { message: PASSWORD_MESSAGE })
  password!: string;

  /** M5: access to every property (default) or only `propertyIds`. */
  @IsOptional() @IsBoolean()
  allProperties?: boolean;

  @IsOptional() @IsArray() @ArrayMaxSize(200) @IsString({ each: true })
  propertyIds?: string[];
}

export class UpdateStaffDto {
  @IsOptional() @IsString() @IsNotEmpty() @MaxLength(120) @Transform(trim)
  fullName?: string;

  @IsOptional() @IsString() @Matches(PHONE_RULE, { message: 'phone must be a valid phone number' }) @Transform(trim)
  phone?: string;

  @IsOptional() @IsEnum(StaffRole)
  role?: StaffRole;

  @IsOptional() @IsString() @MaxLength(60)
  roleId?: string;

  @IsOptional() @IsBoolean()
  isActive?: boolean;

  /** Resets the password and signs the user out everywhere. */
  @IsOptional() @IsString() @Matches(PASSWORD_RULE, { message: PASSWORD_MESSAGE })
  password?: string;

  @IsOptional() @IsBoolean()
  allProperties?: boolean;

  @IsOptional() @IsArray() @ArrayMaxSize(200) @IsString({ each: true })
  propertyIds?: string[];
}
