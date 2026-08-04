import {
  IsInt,
  IsNumber,
  IsObject,
  IsOptional,
  IsUUID,
  Max,
  Min,
} from 'class-validator';

/** The wire schema version this build understands. */
export const TELEMETRY_SCHEMA_VERSION = 1;

/**
 * One 10 Hz sample as published by the on-car uplink. See
 * `~/development/phase2-pi-cloud-uplink-plan.md` for the producer side.
 *
 * Everything but the identity/timing fields is optional: a car with no GPS fix
 * yet still has usable CAN data, and a frame that carries nine of eleven
 * channels is worth keeping. The four that are mandatory are the ones without
 * which the sample cannot be attributed or placed in time.
 */
export class TelemetryFrameDto {
  @IsInt()
  v: number;

  /** The device's session id — the idempotency key for a replayed backlog. */
  @IsUUID()
  sid: string;

  /** Monotonic within `sid`. Half of the dedup key. */
  @IsInt()
  @Min(0)
  seq: number;

  /**
   * Device wall clock, kept for diagnostics only. Sample time is derived from
   * `mono` instead, because a Pi 4 has no RTC.
   */
  @IsOptional()
  @IsInt()
  ts?: number;

  /** Monotonic ms since the device app started. The real time source. */
  @IsInt()
  @Min(0)
  mono: number;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(20_000)
  rpm?: number;

  @IsOptional()
  @IsNumber()
  coolant?: number;

  @IsOptional()
  @IsNumber()
  oil?: number;

  @IsOptional()
  @IsNumber()
  @Min(0)
  speed?: number;

  // Bounds are the coordinate system's, not a track's — a car may be anywhere.
  @IsOptional()
  @IsNumber()
  @Min(-90)
  @Max(90)
  lat?: number;

  @IsOptional()
  @IsNumber()
  @Min(-180)
  @Max(180)
  lon?: number;

  @IsOptional()
  @IsNumber()
  gx?: number;

  @IsOptional()
  @IsNumber()
  gy?: number;

  @IsOptional()
  @IsNumber()
  gz?: number;

  @IsOptional()
  @IsInt()
  @Min(0)
  lap?: number;

  @IsOptional()
  @IsInt()
  @Min(0)
  lapMs?: number;

  @IsOptional()
  @IsInt()
  fix?: number;

  @IsOptional()
  @IsInt()
  sats?: number;

  /** Channels not (yet) worth a column of their own. */
  @IsOptional()
  @IsObject()
  ext?: Record<string, unknown>;
}
