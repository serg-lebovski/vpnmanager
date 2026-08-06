import { IsArray, IsOptional, IsString, IsUUID, MinLength, ValidateIf } from 'class-validator';

export class UpdateBridgeDto {
  @IsString()
  @MinLength(1)
  @IsOptional()
  name?: string;

  // null — сделать мост общим/суперадминским; отсутствие поля — не менять организацию.
  @IsUUID()
  @ValidateIf((_, value) => value !== null)
  @IsOptional()
  organizationId?: string | null;

  // null — очистить домен (вернуться к IP self-сервера в клиентских конфигах);
  // отсутствие поля — не менять.
  @IsString()
  @MinLength(1)
  @ValidateIf((_, value) => value !== null)
  @IsOptional()
  domainName?: string | null;

  // Полная замена списка (как upstreamCandidates) — каждая строка либо IP/CIDR, либо
  // домен; точная валидация формата и дедупликация — в BridgesService.update.
  @IsArray()
  @IsString({ each: true })
  @IsOptional()
  bypassDestinations?: string[];
}
