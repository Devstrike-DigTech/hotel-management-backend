import { Transform } from 'class-transformer';
import {
  IsEmail,
  IsNotEmpty,
  IsString,
  Matches,
  MaxLength,
  MinLength,
} from 'class-validator';

const trim = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.trim() : value;
const lowerTrim = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.trim().toLowerCase() : value;

export const PASSWORD_RULE = /^(?=.*[A-Za-z])(?=.*\d).{8,128}$/;
export const PASSWORD_MESSAGE =
  'password must be 8-128 characters and contain a letter and a number';
export const PHONE_RULE = /^\+?[0-9 ()-]{7,20}$/;

export class SignupDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(120)
  @Transform(trim)
  hotelName!: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(80)
  @Transform(trim)
  city!: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(80)
  @Transform(trim)
  state!: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(120)
  @Transform(trim)
  fullName!: string;

  @IsEmail()
  @MaxLength(254)
  @Transform(lowerTrim)
  email!: string;

  @IsString()
  @Matches(PHONE_RULE, { message: 'phone must be a valid phone number' })
  @Transform(trim)
  phone!: string;

  @IsString()
  @Matches(PASSWORD_RULE, { message: PASSWORD_MESSAGE })
  password!: string;
}

export class LoginDto {
  @IsEmail()
  @MaxLength(254)
  @Transform(lowerTrim)
  email!: string;

  @IsString()
  @MinLength(1)
  @MaxLength(128)
  password!: string;
}

export class RefreshDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(256)
  refreshToken!: string;
}
