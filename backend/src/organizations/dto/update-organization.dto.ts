import { IsOptional, IsString, MinLength } from 'class-validator';

export class UpdateOrganizationDto {
  @IsString()
  @MinLength(1)
  @IsOptional()
  name?: string;
}
