import { IsString, MinLength } from 'class-validator';

export class RegisterViaPortalDto {
  @IsString()
  @MinLength(1)
  orgQuery: string;

  @IsString()
  @MinLength(1)
  fullName: string;
}
