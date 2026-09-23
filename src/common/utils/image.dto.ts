import { Transform } from 'class-transformer';
import { IsString, IsUrl, MaxLength } from 'class-validator';

export class ImageDto {
  @IsUrl({ protocols: ['https', 'http'], require_protocol: true })
  @MaxLength(2048)
  url!: string;

  @IsString()
  @MaxLength(200)
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim() : value,
  )
  alt!: string;
}
