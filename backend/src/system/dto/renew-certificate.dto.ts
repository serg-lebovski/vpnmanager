import { IsBoolean, IsOptional } from 'class-validator';

export class RenewCertificateDto {
  // Форсирует certbot renew даже если сертификат ещё не приблизился к истечению —
  // используется кнопкой "Обновить сейчас", чтобы её можно было проверить end-to-end
  // даже на свежем сертификате.
  @IsBoolean()
  @IsOptional()
  force?: boolean;
}
