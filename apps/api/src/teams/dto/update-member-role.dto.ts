import { TeamRole } from '@app/common';
import { IsEnum, IsNotEmpty } from 'class-validator';

export class UpdateMemberRoleDto {
  @IsNotEmpty()
  @IsEnum(TeamRole)
  role: TeamRole;
}
