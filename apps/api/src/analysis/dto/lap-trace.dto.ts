import { LapRef, SeamDto } from './optimal-lap.dto';

/**
 * One point of a lap's racing line, indexed by distance rather than by time.
 *
 * Distance is the axis because it is the only one two laps share. Two laps of
 * the same circuit have the same length and different durations, so a time axis
 * puts a corner in a different place on every lap and makes overlaid channel
 * traces meaningless.
 */
export interface LapTracePointDto {
  /** Metres from the start/finish line. */
  distM: number;
  /** Milliseconds since the car crossed the line. */
  elapsedMs: number;
  lat: number;
  lon: number;
  speedKmh: number | null;
  rpm: number | null;
  coolantC: number | null;
  oilC: number | null;
  gLat: number | null;
  gLon: number | null;
}

export interface LapTraceDto {
  lapNumber: LapRef;
  lapMs: number;
  distanceM: number;
  points: LapTracePointDto[];
  /**
   * Interior-join gaps, present only when `lapNumber` is `'optimal'` — a
   * numbered lap's trace is one continuous recording with nothing to seam.
   * See `SeamDto`.
   */
  seams?: SeamDto[];
}

/** One step of a lap-vs-lap comparison, on the common distance axis. */
export interface LapDeltaPointDto {
  distM: number;
  /** Elapsed time at this distance on each lap. */
  elapsedAMs: number;
  elapsedBMs: number;
  /** Positive means lap B is behind lap A here. */
  deltaMs: number;
  speedAKmh: number | null;
  speedBKmh: number | null;
}

export interface LapCompareDto {
  lapA: LapRef;
  lapB: LapRef;
  /**
   * The axis both laps were resampled onto: 0 to the shorter lap's distance.
   * Extrapolating the shorter lap past its own end would invent a delta.
   */
  distanceM: number;
  points: LapDeltaPointDto[];
}
