/**
 * Redis channel and key scheme for the live path.
 *
 * `telemetry-ingest` publishes; `api` subscribes and fans out to browsers over
 * WebSocket. Both sides share these helpers for the same reason they share
 * `mqtt-topics.ts` — a channel name spelled slightly differently on one side is
 * a live view that silently never updates.
 *
 * **Channels are per car, not per session.** A viewer watches a *car*, and with
 * device-driven sessions they cannot know the session id before the car opens
 * one. Keying on the car means a viewer stays attached across a stop/start; the
 * session id rides in the payload instead.
 */

/** Live frames for one car, at the device's publish rate. */
export const liveCarChannel = (carId: string) => `live:car:${carId}`;

/** Session lifecycle (start/stop) for one car. */
export const liveCarEventsChannel = (carId: string) =>
  `live:car:${carId}:events`;

/**
 * Last-known value for one car — the newest frame, so a viewer joining
 * mid-session renders immediately instead of waiting for the next frame.
 */
export const lkvCarKey = (carId: string) => `lkv:car:${carId}`;

/**
 * How long a last-known value survives without being refreshed.
 *
 * There must be a TTL. Without one a car that stopped publishing an hour ago
 * still reads as live, and its last known position — a named driver's location
 * — sits in a non-durable, unaudited store indefinitely. Five minutes rides out
 * an LTE dropout while staying far short of "a stale fix looks current".
 */
export const LKV_TTL_SECONDS = 300;

/**
 * How stale a cached frame may be and still seed a joining viewer.
 *
 * Kept beside the TTL because the two are one policy and are read together:
 * the TTL bounds how long a fix lingers at all, this bounds how old one may be
 * while being *presented as current*. Well short of the TTL on purpose — a
 * frame can outlive the `stop` that deleted the key, since frames and session
 * events arrive on different MQTT topics and one still in flight re-`SET`s it.
 */
export const LKV_MAX_SEED_AGE_MS = 15_000;

/** What a `live:car:…` channel carries. */
export type LiveChannelKind = 'frame' | 'event';

export interface ParsedLiveChannel {
  carId: string;
  kind: LiveChannelKind;
}

/**
 * Reads a channel name back into the car and payload kind it denotes, or null
 * if it is not one of ours.
 *
 * A subscriber gets frames and lifecycle events over the same connection and
 * has to tell them apart; doing it by channel shape keeps that decision here
 * rather than duplicated at each `on('message')`.
 */
export const parseLiveChannel = (channel: string): ParsedLiveChannel | null => {
  const segments = channel.split(':');

  if (segments[0] !== 'live' || segments[1] !== 'car' || !segments[2]) {
    return null;
  }

  if (segments.length === 3) {
    return { carId: segments[2], kind: 'frame' };
  }

  return segments.length === 4 && segments[3] === 'events'
    ? { carId: segments[2], kind: 'event' }
    : null;
};
