import { IsEnum, IsOptional, IsString, IsUUID, MinLength } from 'class-validator';
import { VpnProtocol } from '../../common/enums';

export class CreatePeerDto {
  @IsEnum(VpnProtocol)
  protocol: VpnProtocol;

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
