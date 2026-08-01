import { IsEnum, IsInt, IsString, IsUUID, Matches, Max, Min, MinLength } from 'class-validator';
import { VpnProtocol } from '../../common/enums';

export class CreateBridgeDto {
  @IsString()
  @MinLength(1)
  name: string;

  // Существующий Server (уже добавленный на вкладке «Серверы»), указывающий на хост, где
  // крутится сама панель — на нём будет поднят локальный клиентский интерфейс моста.
  @IsUUID()
  selfServerId: string;

  // Протокол, которым клиенты моста подключаются к self-серверу. По умолчанию был бы
  // WireGuard, но в странах, где сам WireGuard блокируется/детектится DPI, нужна
  // обфускация уже на этом (клиентском) хопе — не только на upstream.
  @IsEnum(VpnProtocol)
  protocol: VpnProtocol;

  @IsInt()
  @Min(1)
  @Max(65535)
  listenPort: number;

  @IsString()
  @Matches(/^\d+\.\d+\.\d+\.0\/24$/)
  networkCidr: string;
}
