import { IsEnum, IsInt, IsOptional, IsString, Max, Min, MinLength } from 'class-validator';
import { SshAuthType } from '../../common/enums';

// Отдельный от UpdateServerDto эндпоинт (тот же паттерн, что /test-connection, /reboot,
// /detect) — переввод учётных данных нужен узко, когда sshSecretEnc не расшифровывается
// (см. ServersService.findAll — needsCredentials), не как часть общего переименования.
export class UpdateServerCredentialsDto {
  @IsString()
  @MinLength(1)
  @IsOptional()
  sshUsername?: string;

  @IsInt()
  @Min(1)
  @Max(65535)
  @IsOptional()
  sshPort?: number;

  @IsEnum(SshAuthType)
  @IsOptional()
  sshAuthType?: SshAuthType;

  @IsString()
  @MinLength(1)
  secret: string;
}
