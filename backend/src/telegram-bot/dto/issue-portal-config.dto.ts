import { IsBoolean, IsEnum, IsOptional, IsString } from 'class-validator';
import { PeerDeviceType, VpnProtocol } from '../../common/enums';

export class IssuePortalConfigDto {
  @IsEnum(PeerDeviceType)
  deviceType: PeerDeviceType;

  // Игнорируется, если multiProtocol = true — см. TelegramPortalService.issueConfig.
  @IsEnum(VpnProtocol)
  protocol: VpnProtocol;

  // Мультиконфиг — WireGuard + AmneziaWG одним .vpn-файлом для официального приложения
  // AmneziaVPN (см. PeersService.createMultiProtocolForTelegramRegistration).
  @IsBoolean()
  @IsOptional()
  multiProtocol?: boolean;

  @IsString()
  @IsOptional()
  upstreamKey?: string;
}
