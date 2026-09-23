import { Transform } from 'class-transformer';
import { IsEmail, IsIn, IsOptional, IsString, Length, Matches, MaxLength, ValidateIf } from 'class-validator';

const trim = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value);

export class OtpStartDto {
  @IsString() @Length(7, 24) phone!: string;
  @IsOptional() @IsIn(['SMS', 'WHATSAPP']) channel?: 'SMS' | 'WHATSAPP';
}

export class OtpVerifyDto {
  @IsString() @Length(36, 36) challengeId!: string;
  @Matches(/^\d{6}$/, { message: 'code must be 6 digits' }) code!: string;
}

export class EmailStartDto {
  @IsEmail() @MaxLength(160) @Transform(trim) email!: string;
}

export class EmailVerifyDto {
  @IsString() @Length(10, 2000) token!: string;
}

export class GuestRefreshDto {
  @IsString() @Length(20, 200) refreshToken!: string;
}

export class UpdateGuestMeDto {
  @IsOptional() @IsString() @Length(2, 120) @Transform(trim) fullName?: string;
  @IsOptional() @ValidateIf((_o, v) => v !== null) @IsEmail() @MaxLength(160) @Transform(trim) email?: string | null;
}
