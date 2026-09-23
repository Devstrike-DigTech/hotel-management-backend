import { PartialType } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';
import { ImageDto } from '../../common/utils/image.dto.js';

const trim = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.trim() : value;

export const MAX_KOBO = 2_000_000_000;

export class CreateRoomTypeDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(80)
  @Transform(trim)
  name!: string;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  description?: string;

  @IsInt()
  @Min(0)
  @Max(MAX_KOBO)
  basePriceKobo!: number;

  /** Requires the `hourly_bookings` feature when non-null. */
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(MAX_KOBO)
  hourlyPriceKobo?: number | null;

  @IsInt()
  @Min(1)
  @Max(20)
  capacity!: number;

  @IsString()
  @IsNotEmpty()
  @MaxLength(40)
  bedType!: string;

  @IsInt()
  @Min(1)
  @Max(2000)
  sizeSqm!: number;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(40)
  @IsString({ each: true })
  @MaxLength(60, { each: true })
  amenities?: string[];

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(20)
  @ValidateNested({ each: true })
  @Type(() => ImageDto)
  images?: ImageDto[];
}

export class UpdateRoomTypeDto extends PartialType(CreateRoomTypeDto) {}
