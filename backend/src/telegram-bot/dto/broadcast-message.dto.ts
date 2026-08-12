import { IsBoolean, IsOptional, IsString, MinLength } from 'class-validator';

export class BroadcastMessageDto {
  @IsString()
  @MinLength(1)
  text: string;

  @IsBoolean()
  @IsOptional()
  pin?: boolean;
}
