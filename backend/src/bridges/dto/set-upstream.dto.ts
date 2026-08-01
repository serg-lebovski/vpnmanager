import { IsUUID } from 'class-validator';

export class SetUpstreamDto {
  @IsUUID()
  serverProtocolId: string;
}
