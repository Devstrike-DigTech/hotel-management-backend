import { Transform } from 'class-transformer';
import { IsEnum, IsNotEmpty, IsOptional, IsString, Matches, MaxLength } from 'class-validator';
import { BillingInterval } from '../../generated/prisma/enums.js';

export class CheckoutDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(40)
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim().toLowerCase() : value,
  )
  planCode!: string;

  @IsEnum(BillingInterval)
  interval!: BillingInterval;

  /** M6: subscription coupon (e.g. first 3 months 50% off). */
  @IsOptional()
  @IsString()
  @MaxLength(32)
  @Transform(({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim().toUpperCase() : value))
  couponCode?: string;
}

export class CouponCheckQueryDto {
  @IsString() @IsNotEmpty() @MaxLength(32)
  @Transform(({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim().toUpperCase() : value))
  code!: string;

  @IsString() @IsNotEmpty() @MaxLength(40)
  @Transform(({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim().toLowerCase() : value))
  planCode!: string;

  @IsEnum(BillingInterval)
  interval!: BillingInterval;
}

export class ConfirmDto {
  @IsString()
  @Matches(/^[A-Za-z0-9_-]{6,64}$/, { message: 'reference is invalid' })
  reference!: string;
}
