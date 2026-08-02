import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  Max,
  Min,
  MinLength,
  ValidateNested,
} from 'class-validator';
import { VpnProtocol } from '../../common/enums';

export class BridgeClientProtocolInput {
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

export class CreateBridgeDto {
  @IsString()
  @MinLength(1)
  name: string;

  // Существующий Server (уже добавленный на вкладке «Серверы»), указывающий на хост, где
  // крутится сама панель — на нём будет поднят локальный клиентский интерфейс(ы) моста.
  // На одном self-сервере может быть несколько мостов (разные порты/сети).
  @IsUUID()
  selfServerId: string;

  // Организация, для которой этот мост — если не указана, мост общий/суперадминский.
  @IsUUID()
  @IsOptional()
  organizationId?: string;

  // Один или два клиентских протокола (WireGuard и/или AmneziaWG), каждый со своим
  // портом и сетью. Там, где обычный WireGuard блокируется/детектится DPI, нужна
  // обфускация уже на клиентском хопе — не только на upstream; а если WG у части
  // клиентов работает нормально, можно выдавать peers по обоим протоколам сразу
  // с одного и того же моста (оба маршрутизируются через один upstream).
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(2)
  @ValidateNested({ each: true })
  @Type(() => BridgeClientProtocolInput)
  clientProtocols: BridgeClientProtocolInput[];
}
