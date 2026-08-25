import { IsBoolean, IsEnum, IsOptional, IsString, IsUUID, MinLength } from 'class-validator';
import { VpnProtocol } from '../../common/enums';

export class CreatePeerDto {
  // Игнорируется, если multiProtocol = true (создаются сразу оба протокола) — но всё
  // равно обязателен на уровне DTO, чтобы форма не могла прислать вообще без протокола
  // для обычного (не мульти-) создания.
  @IsEnum(VpnProtocol)
  protocol: VpnProtocol;

  // «Мультиконфиг» — создать сразу два связанных peer'а (WireGuard и AmneziaWG) на одном
  // и том же мосту/сервере и выдать их одним .vpn-файлом для официального приложения
  // AmneziaVPN, где протокол переключается прямо внутри приложения без повторного
  // импорта. Требует, чтобы оба протокола были активны на выбранном мосту/сервере — иначе
  // 400 (см. PeersService.createMultiProtocol).
  @IsBoolean()
  @IsOptional()
  multiProtocol?: boolean;

  @IsString()
  @MinLength(1)
  name: string;

  @IsUUID()
  @IsOptional()
  serverId?: string;

  // Клиент конкретного моста — взаимоисключимо с serverId. org_admin/org_user могут
  // указывать только мост своей организации (или общий), иначе 403.
  @IsUUID()
  @IsOptional()
  bridgeId?: string;

  // Только для SUPER_ADMIN: создать peer сразу для конкретной организации. Явный null —
  // «без клиента» (peer не привязан ни к одной организации); отсутствие поля вообще —
  // ошибка (см. PeersService.resolveOrganizationId), суперадмин должен выбрать осознанно.
  @IsUUID()
  @IsOptional()
  organizationId?: string | null;
}
