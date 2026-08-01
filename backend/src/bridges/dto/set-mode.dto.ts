import { IsEnum } from 'class-validator';
import { BridgeUpstreamMode } from '../../common/enums';

export class SetModeDto {
  @IsEnum(BridgeUpstreamMode)
  mode: BridgeUpstreamMode;
}
