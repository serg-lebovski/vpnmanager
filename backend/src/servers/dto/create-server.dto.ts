import { Transform } from 'class-transformer';
import { IsEnum, IsInt, IsOptional, IsString, Max, Min, MinLength } from 'class-validator';
import { SshAuthType } from '../../common/enums';

export class CreateServerDto {
  @IsString()
  @MinLength(1)
  name: string;

  // Поймано вживую: вставленный из буфера IP с невидимым хвостовым пробелом ("1.2.3.4 ")
  // проходит валидацию (строка непустая), но `net.isIP()` в Node его не распознаёт как
  // IP-литерал — ssh2/node-ssh тогда пытается резолвить его как домен через DNS и падает
  // с getaddrinfo ENOTFOUND вместо понятной ошибки о неверном адресе.
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @IsString()
  @MinLength(1)
  host: string;

  @IsInt()
  @Min(1)
  @Max(65535)
  @IsOptional()
  sshPort?: number = 22;

  @IsString()
  @MinLength(1)
  sshUsername: string;

  @IsEnum(SshAuthType)
  sshAuthType: SshAuthType;

  // Пароль или приватный ключ (в зависимости от sshAuthType), шифруется перед сохранением в БД.
  @IsString()
  @MinLength(1)
  secret: string;

  @IsInt()
  @Min(1)
  @IsOptional()
  maxPeers?: number = 100;
}
