import { IsEnum, IsOptional, IsString } from 'class-validator';
import { PeerDeviceType, VpnProtocol } from '../../common/enums';

export class IssuePortalConfigDto {
  @IsEnum(PeerDeviceType)
  deviceType: PeerDeviceType;

  @IsEnum(VpnProtocol)
  protocol: VpnProtocol;

  @IsString()
  @IsOptional()
  upstreamKey?: string;
}
