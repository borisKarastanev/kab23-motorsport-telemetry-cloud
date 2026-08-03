import { TeamRole } from '@app/common';
import { IsEmail, IsEnum, IsNotEmpty, IsOptional } from 'class-validator';

export class InviteMemberDto {
  @IsNotEmpty()
  @IsEmail()
  email: string;

  @IsOptional()
  @IsEnum(TeamRole)
  role?: TeamRole;
}
