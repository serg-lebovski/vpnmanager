import { IsArray, IsBoolean, IsInt, IsOptional, IsString, IsUUID, Min, MinLength, ValidateIf } from 'class-validator';

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

  // true — сделать этот мост "по умолчанию" (сбрасывает флаг у всех остальных мостов, см.
  // BridgesService.update) — бот/портал будут молча создавать/перевыпускать на нём новые
  // конфиги, не спрашивая выбор сервера, если он один из доступных вариантов организации
  // (см. PeersService.listUpstreamOptions/listMultiProtocolUpstreamOptions). false —
  // снять флаг с этого моста (тогда default нет ни у одного, пока не назначат явно).
  // Отсутствие поля — не менять.
  @IsBoolean()
  @IsOptional()
  isDefault?: boolean;

  // Лимит активных peers на этом мосту — null снимает лимит (действует только общий лимит
  // self-сервера); отсутствие поля — не менять.
  @IsInt()
  @Min(1)
  @ValidateIf((_, value) => value !== null)
  @IsOptional()
  maxPeers?: number | null;
}
