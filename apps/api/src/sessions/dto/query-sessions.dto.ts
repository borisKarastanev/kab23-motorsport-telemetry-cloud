import { SessionStatus } from '@app/common';
import { IsEnum, IsOptional, IsUUID } from 'class-validator';

export class QuerySessionsDto {
  @IsOptional()
  @IsUUID()
  carId?: string;

  @IsOptional()
  @IsUUID()
  teamId?: string;

  @IsOptional()
  @IsEnum(SessionStatus)
  status?: SessionStatus;
}
