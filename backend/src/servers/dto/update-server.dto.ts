import { Transform } from 'class-transformer';
import { IsInt, IsOptional, IsString, Min, MinLength } from 'class-validator';

export class UpdateServerDto {
  @IsString()
  @MinLength(1)
  @IsOptional()
  name?: string;

  // Новый IP/хост сервера — нужен при переезде (в первую очередь self-сервера панели на
  // другой VPS после восстановления бэкапа, см. README «Переезд панели»). Сбрасывает
  // TOFU-отпечаток SSH host key (это другая машина). Trim — см. CreateServerDto.host.
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @IsString()
  @MinLength(1)
  @IsOptional()
  host?: string;

  // Ограничивает, сколько ACTIVE peers может выбрать этот сервер (см.
  // LoadBalancerService.pickServerProtocol) — в т.ч. для мостов: peers моста это обычные
  // peers на клиентском ServerProtocol self-сервера, лимит общий.
  @IsInt()
  @Min(1)
  @IsOptional()
  maxPeers?: number;

  // Имя профиля в официальном приложении AmneziaVPN (см. Server.amneziaAppName) — пустая
  // строка/null сбрасывает на дефолт (используется обычное name). Не задано вообще — не
  // менять текущее значение.
  @IsString()
  @IsOptional()
  amneziaAppName?: string | null;
}
