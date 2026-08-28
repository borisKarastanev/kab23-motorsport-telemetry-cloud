/**
 * The Phase 4 analysis contract, mirrored from `apps/api/src/analysis/dto`.
 *
 * Duplicated rather than imported, as `live-telemetry.model.ts` already is: the
 * frontend is a separate pnpm project with no path into the Nest monorepo. Drift
 * shows up as a column reading `undefined`, not as bad data — but keep the two
 * in step.
 */

export type SessionStatus = 'LIVE' | 'COMPLETED' | 'ABORTED';

/** A row of `GET /sessions`. */
export interface SessionListItem {
  id: string;
  carId: string;
  driverId: string;
  track: string;
  startedAt: string;
  endedAt?: string;
  status: SessionStatus;
  analyzedAt?: string | null;
  /** Zero until the session has been analyzed — see `bestLapMs`. */
  lapCount: number;
  /**
   * Null when there are no laps. That covers both "the car never completed
   * one" and "nobody has opened this session yet", because derivation is lazy
   * and those are the same state until someone looks.
   */
  bestLapMs: number | null;
}

export interface BrakingPoint {
  distM: number;
  lat: number;
  lon: number;
  entrySpeedKmh: number;
  peakDecelG: number;
}

/** A real lap number, or the literal `'optimal'` — the best-sector stitch. */
export type LapRef = number | 'optimal';

/** How a session's laps split their sectors. See `sector-gates.ts` (backend). */
export type SectorScheme = 'gates' | 'distance';

export interface OptimalSector {
  sector: number;
  lapNumber: number;
  sectorMs: number;
}

/** The physical gap, in metres, between two contributing laps at one join. */
export interface Seam {
  distM: number;
  gapM: number;
}

export interface OptimalLap {
  lapMs: number;
  distanceM: number;
  sectors: OptimalSector[];
  brakingPoints: BrakingPoint[];
  /** Set when every sector came from one lap — the optimal *is* that lap. */
  matchesLapNumber: number | null;
  seams: Seam[];
}

export interface Lap {
  id: string;
  sessionId: string;
  lapNumber: number;
  startedAt: string;
  endedAt: string;
  lapMs: number;
  distanceM: number;
  maxSpeedKmh: number | null;
  minSpeedKmh: number | null;
  /** Per-sector durations, summing to `lapMs`. Empty if it could not be split. */
  sectorMs: number[];
  brakingPoints: BrakingPoint[];
  isBest: boolean;
}

/**
 * Why a session has no laps.
 *
 * None of these is an error — the API answers 200 with one of them, so the view
 * can say which it is instead of showing a generic failure.
 */
export type AnalysisSkipReason =
  | 'no-track-gate'
  | 'session-live'
  | 'no-samples'
  | 'too-many-samples'
  | 'no-crossings';

export interface LapsResponse {
  laps: Lap[];
  analyzedAt: string | null;
  /** The best-sector stitch across `laps`, or `null` under two eligible laps. */
  optimal: OptimalLap | null;
  /** Absent (or `'distance'`) on a session derived before gates existed. */
  sectorScheme?: SectorScheme;
  reason?: AnalysisSkipReason;
}

export interface LapTracePoint {
  distM: number;
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

export interface LapTrace {
  lapNumber: LapRef;
  lapMs: number;
  distanceM: number;
  points: LapTracePoint[];
  /** Present only when `lapNumber` is `'optimal'`. */
  seams?: Seam[];
}

export interface LapDeltaPoint {
  distM: number;
  elapsedAMs: number;
  elapsedBMs: number;
  /** Positive means lap B is behind lap A here. */
  deltaMs: number;
  speedAKmh: number | null;
  speedBKmh: number | null;
}

export interface LapCompare {
  lapA: LapRef;
  lapB: LapRef;
  distanceM: number;
  points: LapDeltaPoint[];
}
