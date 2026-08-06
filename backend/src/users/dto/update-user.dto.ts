import { IsEnum, IsOptional, IsString, IsUUID, MinLength, ValidateIf } from 'class-validator';
import { Role } from '../../common/enums';

export class UpdateUserDto {
  // Не обязательно email — просто уникальный логин (см. LoginDto).
  @IsString()
  @MinLength(1)
  @IsOptional()
  email?: string;

  @IsString()
  @MinLength(10)
  @IsOptional()
  password?: string;

  @IsEnum(Role)
  @IsOptional()
  role?: Role;

  // null — убрать пользователя из организации (нужно при повышении до super_admin);
  // отсутствие поля — не менять текущую организацию.
  @IsUUID()
  @ValidateIf((_, value) => value !== null)
  @IsOptional()
  organizationId?: string | null;
}
