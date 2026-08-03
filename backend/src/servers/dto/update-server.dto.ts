import { IsOptional, IsString, MinLength } from 'class-validator';

export class UpdateServerDto {
  @IsString()
  @MinLength(1)
  @IsOptional()
  name?: string;
}
