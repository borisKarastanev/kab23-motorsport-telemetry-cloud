/**
 * The shapes the derivation pass works in.
 *
 * Deliberately free of TypeORM: everything under `analysis/` except the service
 * and the repositories is a pure function over these, which is what lets the
 * edge cases in `gate-crossing.spec.ts` be tested against hand-built traces
 * rather than against a database.
 */

/**
 * One sample, as the analysis pass reads it.
 *
 * A structural subset of `TelemetrySample` (which lives in
 * `apps/telemetry-ingest` and must not be imported from here). Every channel
 * but `time` is optional because every channel but `time` genuinely can be
 * absent: a fix can arrive with no GPS lock, and the `--replay` path for a dash
 * session record carries geometry with no g channels at all.
 */
export interface AnalysisSample {
  time: Date;
  lat?: number;
  lon?: number;
  speedKmh?: number;
  rpm?: number;
  coolantC?: number;
  oilC?: number;
  gLat?: number;
  gLon?: number;
}

/**
 * One point on a lap's path, as the derivation carries it internally.
 *
 * `distM` — cumulative distance from the start/finish line — is what sectors
 * and braking points are expressed in, and is computed once here rather than
 * re-derived by each consumer.
 */
export interface LapPoint {
  timeMs: number;
  lat: number;
  lon: number;
  distM: number;
  speedKmh?: number;
  gLon?: number;
}

/** A start/finish or split gate, as two endpoints spanning the track. */
export interface Gate {
  lat1: number;
  lon1: number;
  lat2: number;
  lon2: number;
}

/**
 * Where a driver got hard on the brakes, in lap-relative terms.
 *
 * `distM` is along-lap distance rather than a timestamp on purpose: the whole
 * point of the marker is to be comparable between two laps of different
 * duration, and only distance survives that.
 */
export interface BrakingPoint {
  /** Distance along the lap at which the deceleration started, in metres. */
  distM: number;
  lat: number;
  lon: number;
  /** Speed on entry to the braking zone. */
  entrySpeedKmh: number;
  /** Peak deceleration through the zone, in g, as a positive number. */
  peakDecelG: number;
}

/** One completed lap, before it becomes a `Lap` row. */
export interface DerivedLap {
  lapNumber: number;
  startedAt: Date;
  endedAt: Date;
  lapMs: number;
  distanceM: number;
  maxSpeedKmh: number | null;
  minSpeedKmh: number | null;
  /**
   * Per-sector durations, in order, summing to `lapMs`. See `sectors.ts` —
   * these are distance-fraction splits, not gate splits.
   */
  sectorMs: number[];
  brakingPoints: BrakingPoint[];
}
