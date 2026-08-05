import { IsOptional, IsString, IsUUID, MinLength, ValidateIf } from 'class-validator';

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
}
