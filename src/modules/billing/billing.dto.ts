import { Transform } from 'class-transformer';
import { IsEnum, IsNotEmpty, IsString, Matches, MaxLength } from 'class-validator';
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
}

export class ConfirmDto {
  @IsString()
  @Matches(/^[A-Za-z0-9_-]{6,64}$/, { message: 'reference is invalid' })
  reference!: string;
}
