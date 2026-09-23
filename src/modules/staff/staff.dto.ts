import { Transform } from 'class-transformer';
import {
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

  @IsEnum(StaffRole)
  role!: StaffRole;

  @IsString() @Matches(PASSWORD_RULE, { message: PASSWORD_MESSAGE })
  password!: string;
}

export class UpdateStaffDto {
  @IsOptional() @IsString() @IsNotEmpty() @MaxLength(120) @Transform(trim)
  fullName?: string;

  @IsOptional() @IsString() @Matches(PHONE_RULE, { message: 'phone must be a valid phone number' }) @Transform(trim)
  phone?: string;

  @IsOptional() @IsEnum(StaffRole)
  role?: StaffRole;

  @IsOptional() @IsBoolean()
  isActive?: boolean;

  /** Resets the password and signs the user out everywhere. */
  @IsOptional() @IsString() @Matches(PASSWORD_RULE, { message: PASSWORD_MESSAGE })
  password?: string;
}
