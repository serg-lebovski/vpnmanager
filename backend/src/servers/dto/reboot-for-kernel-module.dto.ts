import { IsEnum } from 'class-validator';
import { VpnProtocol } from '../../common/enums';

export class RebootForKernelModuleDto {
  @IsEnum(VpnProtocol)
  protocol: VpnProtocol;
}
