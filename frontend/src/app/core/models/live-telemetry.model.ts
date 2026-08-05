/**
 * The live wire contract, mirrored from
 * `libs/common/src/live-telemetry/live-telemetry-frame.ts`.
 *
 * Duplicated rather than imported: the frontend is a separate pnpm project with
 * its own tsconfig and no path into the Nest monorepo's `libs`. Nothing here is
 * load-bearing on the server, so drift shows up as a field reading `undefined`
 * in a gauge rather than as bad data — but keep the two in step.
 */
export interface LiveFrame {
  v: number;
  sessionId: string;
  carId: string;
  /**
   * Server-anchored sample time, epoch ms. Carries the session's one-off
   * anchoring offset, so it is for display and ordering — not for latency.
   */
  t: number;
  /** Wall clock at publish. The only field `now - x` means anything against. */
  pt: number;
  seq: number;
  rpm?: number;
  coolant?: number;
  oil?: number;
  speed?: number;
  lat?: number;
  lon?: number;
  gx?: number;
  gy?: number;
  gz?: number;
  lap?: number;
  lapMs?: number;
  ext?: Record<string, unknown>;
}

export interface LiveSessionEvent {
  v: number;
  carId: string;
  sessionId: string;
  event: 'start' | 'stop';
  t: number;
}

export interface TracePoint {
  lat: number;
  lon: number;
}

export type LiveState =
  | 'idle'
  | 'connecting'
  | 'connected'
  | 'disconnected'
  | 'error';

/** Only what the live view needs off `GET /cars`. */
export interface Car {
  id: string;
  name: string;
  make?: string;
  model?: string;
  deviceId: string;
}
