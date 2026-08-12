import { IsArray, IsOptional, IsString, MinLength } from 'class-validator';

export class CreateTelegramContentDto {
  @IsString()
  @IsOptional()
  title?: string;

  @IsString()
  @MinLength(1)
  body: string;

  @IsArray()
  @IsString({ each: true })
  @IsOptional()
  images?: string[];
}
