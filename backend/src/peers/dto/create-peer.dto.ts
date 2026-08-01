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

  // Только для SUPER_ADMIN: создать peer сразу для конкретной организации.
  @IsUUID()
  @IsOptional()
  organizationId?: string;
}
