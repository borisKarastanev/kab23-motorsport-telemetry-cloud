import { SectorScheme } from '../analysis.types';
import { Lap } from '../entities/lap.entity';
import { OptimalLapDto } from './optimal-lap.dto';

/**
 * Why a session has no laps.
 *
 * A first-class part of the response rather than an error, because none of
 * these are failures. `SessionEventDto` is explicit that a car may legitimately
 * report a track this platform has never heard of, and a session that is still
 * running simply has not finished yet. Returning 200 with a reason lets the UI
 * say *which* of these it is; a 4xx would collapse all of them into "something
 * went wrong" and invite a retry that cannot help.
 */
export type AnalysisSkipReason =
  /** `Session.track` matched no row in `tracks`, so there is no gate to cut on. */
  | 'no-track-gate'
  /** Still running. Laps are derived once the session closes. */
  | 'session-live'
  /** No telemetry in the session's window at all. */
  | 'no-samples'
  /** More samples than one request should pull into memory. */
  | 'too-many-samples'
  /** Samples and a gate, but the car never crossed the line. */
  | 'no-crossings';

export interface LapsResponseDto {
  laps: Lap[];
  /** When the derivation last ran; null if it has not. */
  analyzedAt: Date | null;
  /**
   * The best-sector-stitch across `laps`, or `null` under two eligible laps —
   * see `optimal-lap-core.ts`. Computed from the rows already in `laps`, so
   * the dropdown gets its label and time in the same round trip that fetches
   * the lap table.
   */
  optimal: OptimalLapDto | null;
  /**
   * How `laps` split their sectors. `'distance'` (or, on a row derived before
   * this column existed, `undefined`) means the legacy equal-thirds fallback
   * — see `sectors.ts` and `sector-gates.ts`.
   */
  sectorScheme?: SectorScheme;
  /**
   * Why this derivation produced nothing.
   *
   * On a read that is always alongside an empty `laps`. The one exception is a
   * forced recompute that could not run: the previously derived laps are kept
   * rather than destroyed, so they come back with the reason the re-derivation
   * declined. A client showing an empty state should key it on `laps.length`,
   * not on the presence of this.
   *
   * The session itself already carries the `track` string a client would
   * otherwise want alongside this, so there is nothing to echo back —
   * `no-track-gate` says everything about why that string did not resolve.
   */
  reason?: AnalysisSkipReason;
}
