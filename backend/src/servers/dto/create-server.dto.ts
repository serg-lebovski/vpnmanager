import { IsEnum, IsInt, IsOptional, IsString, Max, Min, MinLength } from 'class-validator';
import { SshAuthType } from '../../common/enums';

export class CreateServerDto {
  @IsString()
  @MinLength(1)
  name: string;

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
