/** The live wire schema this build understands. */
export const LIVE_FRAME_SCHEMA_VERSION = 1;

/**
 * One sample on its way to a browser.
 *
 * Deliberately close to the MQTT `TelemetryFrameDto`, so no channel is renamed
 * or re-derived on the way through: what a car published is what a viewer sees.
 *
 * An interface rather than a class-validator DTO. This crosses no trust
 * boundary — `telemetry-ingest` is the only publisher and it builds these from
 * frames it has already validated — so paying `plainToInstance` + `validateSync`
 * per frame per car on the read side would buy nothing. `v` is still checked on
 * receipt: a payload from a build that means something different by these
 * fields must be dropped, not guessed at.
 *
 * It cannot simply reuse `TelemetrySample`: that entity belongs to
 * `apps/telemetry-ingest`, and `libs/common` must never import from `apps/*`.
 * That makes this a third spelling of the channel list (entity, hypertable DDL,
 * this). What stops the three drifting is the "channel parity with the
 * hypertable" block in `live-publisher.service.spec.ts` — it lives with the
 * mapping it guards, since it needs the same Redis pipeline harness.
 */
export interface LiveFrame {
  v: number;

  sessionId: string;
  carId: string;

  /**
   * Server-anchored sample time, epoch ms — the same value written to the
   * hypertable's `time`, never the device's own clock. A Pi 4 has no RTC.
   *
   * **Not a latency reference.** It is derived as
   * `session.startedAt + (mono - deviceMonoStartMs)`, and `startedAt` is stamped
   * when the *start event* finished its trip through the broker. Every sample in
   * the run therefore carries that one-off offset, which makes `now - t` come
   * out near zero or negative on a fast link. Use `pt` to measure delivery.
   */
  t: number;

  /**
   * Wall-clock instant ingest published this frame, epoch ms.
   *
   * Diagnostics only, and the only field here that supports a latency figure:
   * `now - pt` is a true measure of Redis → gateway → browser. It says nothing
   * about the LTE hop in front of ingest, which is where the glass-to-glass
   * budget is actually spent.
   */
  pt: number;

  /** Monotonic per session. Lets a client see a gap rather than infer one. */
  seq: number;

  rpm?: number;
  coolant?: number;
  oil?: number;
  speed?: number;

  lat?: number;
  lon?: number;

  /** Lateral / longitudinal / vertical acceleration, in g. */
  gx?: number;
  gy?: number;
  gz?: number;

  lap?: number;
  lapMs?: number;

  /** Channels not (yet) worth a column of their own. */
  ext?: Record<string, unknown>;
}

export type LiveSessionEventName = 'start' | 'stop';

/**
 * A run opening or closing, so a viewer can distinguish "the car is between
 * sessions" from "the link dropped" — which look identical from frames alone.
 */
export interface LiveSessionEvent {
  v: number;
  carId: string;
  sessionId: string;
  event: LiveSessionEventName;
  /** Server epoch ms. */
  t: number;
}

/**
 * Decodes a payload off the live bus, or null if this build must not act on it.
 *
 * Both readers go through here — the bus subscription and the seed from the
 * last-known value — because both apply the same rule and a rolling deploy
 * exercises the rarely-used one. Keeping the version gate beside the constant it
 * enforces is what makes a future v2 (accept both, upconvert) one change rather
 * than two, and stops the seed path being the one that was forgotten.
 *
 * Never logs or rethrows the body: it is a driver's position.
 */
export const parseLiveMessage = <T extends LiveFrame | LiveSessionEvent>(
  raw: string,
): T | null => {
  let payload: T;

  try {
    payload = JSON.parse(raw) as T;
  } catch {
    return null;
  }

  return payload?.v === LIVE_FRAME_SCHEMA_VERSION ? payload : null;
};
