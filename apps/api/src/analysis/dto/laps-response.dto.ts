import { Lap } from '../entities/lap.entity';

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
   * Present only when `laps` is empty. The session itself already carries the
   * `track` string the client would otherwise want alongside this, so there is
   * nothing to echo back — `no-track-gate` says everything about why that
   * string did not resolve.
   */
  reason?: AnalysisSkipReason;
}
