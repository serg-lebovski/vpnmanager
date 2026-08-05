import { IsISO8601, IsOptional, IsString, IsUUID, MinLength, ValidateIf } from 'class-validator';

export class UpdatePeerDto {
  @IsString()
  @MinLength(1)
  @IsOptional()
  name?: string;

  // Смена организации peer'а — только для SUPER_ADMIN (проверяется в PeersService.update,
  // не только здесь). Явный null — «без клиента»; отсутствие поля — не менять организацию.
  @IsUUID()
  @ValidateIf((_, value) => value !== null)
  @IsOptional()
  organizationId?: string | null;

  // Срок действия ("подписка" без оплат) — тоже только для SUPER_ADMIN. Явный null —
  // сделать бессрочным; отсутствие поля — не менять срок.
  @IsISO8601()
  @ValidateIf((_, value) => value !== null)
  @IsOptional()
  expiresAt?: string | null;
}
