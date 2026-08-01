import { IsInt, IsString, IsUUID, Matches, Max, Min, MinLength } from 'class-validator';

export class CreateBridgeDto {
  @IsString()
  @MinLength(1)
  name: string;

  // Существующий Server (уже добавленный на вкладке «Серверы»), указывающий на хост, где
  // крутится сама панель — на нём будет поднят локальный WireGuard для клиентов моста.
  @IsUUID()
  selfServerId: string;

  @IsInt()
  @Min(1)
  @Max(65535)
  listenPort: number;

  @IsString()
  @Matches(/^\d+\.\d+\.\d+\.0\/24$/)
  networkCidr: string;
}
