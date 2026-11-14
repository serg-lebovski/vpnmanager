import { IsEnum, IsInt, IsOptional, IsString, Matches, Max, Min, ValidateIf } from 'class-validator';
import { VpnProtocol } from '../../common/enums';

export class InstallProtocolDto {
  @IsEnum(VpnProtocol)
  protocol: VpnProtocol;

  @IsInt()
  @Min(1)
  @Max(65535)
  listenPort: number;

  // Поддерживается только сеть вида a.b.c.0/24. Для VLESS не нужна — у него нет подсети
  // клиентов (прокси, а не L3-туннель).
  @ValidateIf((dto: InstallProtocolDto) => dto.protocol !== VpnProtocol.VLESS)
  @IsString()
  @Matches(/^\d+\.\d+\.\d+\.0\/24$/)
  networkCidr?: string;

  // Только для VLESS — сайт, под который маскируется Reality (см. InstallOptions.realitySni).
  @IsString()
  @Matches(/^[a-z0-9.-]+$/i)
  @IsOptional()
  realitySni?: string;
}
