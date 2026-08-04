import {
  ArrayMaxSize,
  IsArray,
  IsIn,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  Min,
} from 'class-validator';

export type SessionEventName = 'start' | 'stop';

/**
 * A run's start or stop, published by the device on `cars/<deviceId>/session`.
 *
 * The device is authoritative for session boundaries: it knows when the car
 * crossed the line and when the driver saved the run, and the driver should
 * never have to open a web app at the track for a session to exist.
 */
export class SessionEventDto {
  @IsInt()
  v: number;

  @IsUUID()
  sid: string;

  @IsIn(['start', 'stop'])
  event: SessionEventName;

  /** Device wall clock. Diagnostics only — see `mono`. */
  @IsOptional()
  @IsInt()
  at?: number;

  /** Monotonic ms since the device app started; anchors the session's clock. */
  @IsInt()
  @Min(0)
  mono: number;

  // Track identity as the dash knows it. Free text rather than a foreign key:
  // the on-car track database is versioned independently of this platform, so a
  // car may legitimately report a track the cloud has never heard of.
  @IsOptional()
  @IsString()
  @MaxLength(120)
  track?: string;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  trackName?: string;

  /** Lap times, `stop` only. Kept for cross-checking the cloud's own Phase 4 derivation. */
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(500)
  laps?: number[];

  @IsOptional()
  @IsNumber()
  topSpeedKmh?: number;
}
