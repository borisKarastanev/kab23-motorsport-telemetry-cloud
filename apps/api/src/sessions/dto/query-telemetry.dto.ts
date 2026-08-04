import { Type } from 'class-transformer';
import { IsInt, IsISO8601, IsOptional, Max, Min } from 'class-validator';

/** Enough points to draw a trace, few enough that a long session stays cheap. */
export const DEFAULT_MAX_POINTS = 2000;

export class QueryTelemetryDto {
  /** Defaults to the session's own window. */
  @IsOptional()
  @IsISO8601()
  from?: string;

  @IsOptional()
  @IsISO8601()
  to?: string;

  /**
   * Upper bound on returned rows; the bucket width is derived from it. Honoured
   * exactly for `maxPoints >= 2` — see the alignment note in
   * `TelemetryRepository`.
   *
   * Capped rather than optional-unbounded: a 40-minute session holds ~24,000
   * samples, and letting a caller ask for all of them turns one request into a
   * heavy scan and a payload no chart can use.
   */
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(5000)
  maxPoints?: number;
}
