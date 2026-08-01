import { IsEnum, IsInt, IsString, Matches, Max, Min } from 'class-validator';
import { VpnProtocol } from '../../common/enums';

export class InstallProtocolDto {
  @IsEnum(VpnProtocol)
  protocol: VpnProtocol;

  @IsInt()
  @Min(1)
  @Max(65535)
  listenPort: number;

  // Поддерживается только сеть вида a.b.c.0/24
  @IsString()
  @Matches(/^\d+\.\d+\.\d+\.0\/24$/)
  networkCidr: string;
}
