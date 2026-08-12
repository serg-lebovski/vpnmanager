import { IsString, MinLength } from 'class-validator';

export class BroadcastMessageDto {
  @IsString()
  @MinLength(1)
  text: string;
}
