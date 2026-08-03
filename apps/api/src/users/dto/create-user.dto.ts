import {
  IsEmail,
  IsIn,
  IsNotEmpty,
  IsOptional,
  IsStrongPassword,
  IsString,
} from 'class-validator';
import { UserRole } from '@app/common';

/**
 * Roles a caller may assign to themselves at registration.
 *
 * `UserRole.ADMIN` is deliberately absent: it bypasses team membership in
 * `TeamsService.requireTeamRole`, `CarsService.requireReadable/WritableCar`,
 * and the session equivalents, so accepting it here would let anyone
 * self-provision cross-tenant read/write over every team's telemetry. Admins
 * are provisioned out of band.
 */
const SELF_ASSIGNABLE_ROLES = [UserRole.DRIVER, UserRole.MANAGER];

export class CreateUserDto {
  @IsNotEmpty()
  @IsEmail()
  email: string;

  @IsNotEmpty()
  @IsStrongPassword({ minLength: 8, minUppercase: 1, minSymbols: 1 })
  password: string;

  @IsOptional()
  @IsString()
  displayName?: string;

  @IsOptional()
  @IsIn(SELF_ASSIGNABLE_ROLES)
  role?: UserRole;
}
