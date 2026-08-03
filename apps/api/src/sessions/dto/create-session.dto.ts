import {
  IsDateString,
  IsNotEmpty,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
} from 'class-validator';

export class CreateSessionDto {
  @IsNotEmpty()
  @IsUUID()
  carId: string;

  @IsNotEmpty()
  @IsString()
  @MaxLength(120)
  track: string;

  /** Defaults to now. Present so a queued/offline session can be backdated. */
  @IsOptional()
  @IsDateString()
  startedAt?: string;

  /**
   * Only a team manager may set this, to open a session on behalf of one of
   * their drivers; otherwise the session belongs to the caller.
   */
  @IsOptional()
  @IsUUID()
  driverId?: string;
}
