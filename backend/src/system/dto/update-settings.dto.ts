import { IsBoolean, IsEmail, IsOptional, IsString, IsUUID, MinLength, ValidateIf } from 'class-validator';

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

  @IsBoolean()
  @IsOptional()
  telegramEnabled?: boolean;

  // Отсутствие поля — не менять сохранённый токен (не заставляем вводить заново при
  // каждом сохранении остальных настроек).
  @IsString()
  @MinLength(1)
  @IsOptional()
  telegramBotToken?: string;

  @IsString()
  @MinLength(1)
  @IsOptional()
  telegramChatId?: string;

  // null — не маршрутизировать через мост (обычный прямой запрос).
  @IsUUID()
  @ValidateIf((_, value) => value !== null)
  @IsOptional()
  telegramBridgeId?: string | null;
}
