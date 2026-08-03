import { IsEmail, IsEnum, IsOptional, IsString, IsUUID, MinLength, ValidateIf } from 'class-validator';
import { Role } from '../../common/enums';

export class UpdateUserDto {
  @IsEmail()
  @IsOptional()
  email?: string;

  @IsString()
  @MinLength(6)
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
