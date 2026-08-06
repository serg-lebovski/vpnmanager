import { IsEnum, IsOptional, IsString, IsUUID, MinLength } from 'class-validator';
import { Role } from '../../common/enums';

export class CreateUserDto {
  // Не обязательно email — просто уникальный логин (см. LoginDto).
  @IsString()
  @MinLength(1)
  email: string;

  @IsString()
  @MinLength(10)
  password: string;

  @IsEnum(Role)
  role: Role;

  @IsUUID()
  @IsOptional()
  organizationId?: string;
}
