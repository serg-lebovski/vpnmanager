import { IsString, MinLength } from 'class-validator';

export class LoginDto {
  // Не обязательно email — логином может быть и просто имя пользователя (см.
  // CreateUserDto/UpdateUserDto — то же самое поле User.email в БД используется как общий
  // идентификатор для входа, не только как настоящий адрес почты).
  @IsString()
  @MinLength(1)
  email: string;

  @IsString()
  @MinLength(6)
  password: string;
}
