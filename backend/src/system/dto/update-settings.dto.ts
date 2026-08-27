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

  @IsString()
  @IsOptional()
  telegramWelcomeMessage?: string;

  // Ветка git, из которой самообновление подтягивает код (см. UpdateService) — 'main'/
  // 'beta' и т.п. Не влияет на уже собранные образы, применяется при следующем нажатии
  // «Обновить».
  @IsString()
  @MinLength(1)
  @IsOptional()
  deployBranch?: string;

  // Имя профиля в официальном приложении AmneziaVPN по умолчанию (см.
  // SystemSettings.amneziaAppName) — null/пустая строка сбрасывает на внутреннее имя
  // сервера (как было до этой настройки).
  @IsString()
  @ValidateIf((_, value) => value !== null)
  @IsOptional()
  amneziaAppName?: string | null;
}
