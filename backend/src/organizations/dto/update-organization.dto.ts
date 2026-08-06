import { IsArray, IsOptional, IsString, IsUUID, MinLength } from 'class-validator';

export class UpdateOrganizationDto {
  @IsString()
  @MinLength(1)
  @IsOptional()
  name?: string;

  // Полная замена списка (тот же паттерн, что Bridge.bypassDestinations/upstreamCandidates)
  // — какие обычные серверы можно выбрать напрямую (без моста) при создании peer'а.
  @IsArray()
  @IsUUID('4', { each: true })
  @IsOptional()
  allowedServerIds?: string[];

  // Полная замена списка — какие мосты (из видимых организации — общие + свои) НЕДОСТУПНЫ.
  @IsArray()
  @IsUUID('4', { each: true })
  @IsOptional()
  blockedBridgeIds?: string[];
}
