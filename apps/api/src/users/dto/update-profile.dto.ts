import { IsOptional, IsString, MaxLength } from 'class-validator';

/**
 * Profile fields a user may change about themselves. Deliberately excludes
 * `email`, `password`, and `role` — changing those needs its own flow, and
 * whitelisting here is what stops a role escalation via `PATCH /users/me`.
 */
export class UpdateProfileDto {
  @IsOptional()
  @IsString()
  @MaxLength(120)
  displayName?: string;
}
