import { ArrayMinSize, ArrayUnique, IsUUID } from 'class-validator';

export class SetUpstreamCandidatesDto {
  // Порядок элементов = приоритет: индекс 0 — основной сервер, дальше — резервы по
  // убыванию предпочтения.
  @IsUUID('4', { each: true })
  @ArrayUnique()
  @ArrayMinSize(1)
  serverProtocolIds: string[];
}
