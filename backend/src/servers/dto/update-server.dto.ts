import { IsInt, IsOptional, IsString, Min, MinLength } from 'class-validator';

export class UpdateServerDto {
  @IsString()
  @MinLength(1)
  @IsOptional()
  name?: string;

  // Ограничивает, сколько ACTIVE peers может выбрать этот сервер (см.
  // LoadBalancerService.pickServerProtocol) — в т.ч. для мостов: peers моста это обычные
  // peers на клиентском ServerProtocol self-сервера, лимит общий.
  @IsInt()
  @Min(1)
  @IsOptional()
  maxPeers?: number;
}
