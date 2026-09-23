import { PartialType } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import {
  IsISO8601,
  IsEnum,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import { RoomStatus } from '../../generated/prisma/enums.js';

const trim = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.trim() : value;

export class RoomQueryDto {
  @IsOptional()
  @IsEnum(RoomStatus)
  status?: RoomStatus;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(-5)
  @Max(200)
  floor?: number;

  @IsOptional()
  @IsUUID()
  roomTypeId?: string;
}

export class CreateRoomDto {
  @IsUUID()
  roomTypeId!: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(20)
  @Matches(/^[A-Za-z0-9-]+$/, {
    message: 'number may contain letters, digits and dashes only',
  })
  @Transform(trim)
  number!: string;

  @IsInt()
  @Min(-5)
  @Max(200)
  floor!: number;

  @IsOptional()
  @IsEnum(RoomStatus)
  status?: RoomStatus;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  notes?: string | null;
}

export class UpdateRoomDto extends PartialType(CreateRoomDto) {}

export class BulkCreateRoomsDto {
  @IsUUID()
  roomTypeId!: string;

  @IsInt()
  @Min(-5)
  @Max(200)
  floor!: number;

  @IsInt()
  @Min(0)
  @Max(99999)
  from!: number;

  @IsInt()
  @Min(0)
  @Max(99999)
  to!: number;

  @IsOptional()
  @IsString()
  @MaxLength(8)
  @Matches(/^[A-Za-z0-9-]*$/, {
    message: 'prefix may contain letters, digits and dashes only',
  })
  prefix?: string;
}

export class UpdateRoomStatusDto {
  @IsEnum(RoomStatus)
  status!: RoomStatus;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  note?: string;

  /** When the change really happened (offline outbox). */
  @IsOptional()
  @IsISO8601()
  clientCreatedAt?: string;
}
