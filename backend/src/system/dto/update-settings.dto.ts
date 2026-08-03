import { IsBoolean, IsEmail, IsOptional, IsString, MinLength } from 'class-validator';

export class UpdateSettingsDto {
  @IsString()
  @MinLength(1)
  @IsOptional()
  domain?: string;

  @IsEmail()
  @IsOptional()
  letsEncryptEmail?: string;

  @IsBoolean()
  @IsOptional()
  httpEnabled?: boolean;

  @IsBoolean()
  @IsOptional()
  httpsEnabled?: boolean;
}
