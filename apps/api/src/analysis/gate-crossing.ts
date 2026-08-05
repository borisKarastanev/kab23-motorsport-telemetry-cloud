import { Gate } from './analysis.types';
import { METERS_PER_DEG_LAT, metersPerDegLon } from './geo';

/**
 * Does a pair of consecutive fixes cross the gate?
 *
 * A direct port of `RaceBoxModel::updateLapTiming`
 * (`kab23-motorsport-race-dash/src/raceboxmodel.cpp`), which is the
 * battle-tested implementation and already encodes every edge case a season of
 * running into them produced. Ported rather than reinvented for exactly that
 * reason: a fresh implementation of "did the car cross this line" is easy to
 * write and easy to get subtly wrong, and the car and the cloud disagreeing
 * about lap count is the worst possible way to find out.
 *
 * **Pure.** The two rules that need memory — the direction latch and the
 * minimum-lap debounce — are the caller's; `LapSegmenter` holds them. What the
 * latch decides is passed back in as `requiredDirSign`, so this function still
 * enforces it while staying a function of its arguments.
 *
 * Two deliberate departures from the original:
 *
 * 1. **No 250 m pre-filter.** The dash skips the crossing maths when both fixes
 *    are far from the gate midpoint, because it runs this at 25 Hz on a Pi
 *    alongside a rendering QML scene. A batch pass over 24 000 rows on a server
 *    does not need it, and dropping it removes a threshold that could itself
 *    reject a legitimate crossing on a very fast circuit.
 * 2. **Missing channels degrade to "cannot reject" rather than to "reject".**
 *    The dash always has a speed reading; a stored sample may not. See the
 *    stationary check below.
 */

/**
 * Below this, GPS noise alone can carry the reported position across the line
 * while the car is parked on it. A genuinely slow crossing — a hairpin S/F, a
 * kart, a car limping in — is above this and still counts.
 */
export const STATIONARY_SPEED_KMH = 3;

/**
 * Consecutive fixes further apart than this are not bridged into a segment.
 *
 * Straight-line interpolation between two fixes is only honest over a short
 * hop; across a stall it invents a path the car never drove, which near the
 * gate means inventing a crossing. Ported unchanged from the dash: at this
 * repo's 10 Hz storage rate it tolerates four consecutive dropped frames,
 * which is a link hiccup, and rejects anything longer, which is a real gap.
 */
export const MAX_FIX_GAP_MS = 500;

/**
 * Two crossings closer together than this are one crossing seen twice —
 * jitter straddling the line on consecutive fixes. Enforced by `LapSegmenter`,
 * which is what knows when the current lap started.
 */
export const MIN_LAP_MS = 3000;

/** A fix as the crossing maths needs it: a position, a time, and a speed. */
export interface CrossingFix {
  timeMs: number;
  lat: number;
  lon: number;
  speedKmh?: number;
}

export interface GateCrossing {
  /** Epoch ms of the crossing itself, interpolated between the two fixes. */
  crossMs: number;
  /** The point on the gate the car crossed at, not the nearer fix. */
  lat: number;
  lon: number;
  /**
   * Which side the path crossed from. Meaningless in isolation — its only job
   * is to be compared against the direction latched on the arming crossing.
   */
  dirSign: 1 | -1;
  /** Fraction along `prev → cur` at which the crossing happened. */
  t: number;
}

export interface FindGateCrossingOptions {
  /**
   * The racing direction, once latched. A crossing the other way — the
   * pit-lane side of the line, a car reversing out of a spin — is not a lap.
   */
  requiredDirSign?: 1 | -1 | 0;
}

export function findGateCrossing(
  prev: CrossingFix,
  cur: CrossingFix,
  gate: Gate,
  options: FindGateCrossingOptions = {},
): GateCrossing | null {
  if (!isPositioned(prev) || !isPositioned(cur)) {
    return null;
  }

  // Only reject on a speed we actually have. A null speed channel means the
  // sample cannot testify either way, and treating silence as "stationary"
  // would drop every lap of a session whose speed channel dropped out.
  if (cur.speedKmh != null && cur.speedKmh <= STATIONARY_SPEED_KMH) {
    return null;
  }

  const dtMs = cur.timeMs - prev.timeMs;
  if (dtMs <= 0 || dtMs > MAX_FIX_GAP_MS) {
    return null;
  }

  // Project to local metres around the gate midpoint (x = east, y = north).
  const midLat = (gate.lat1 + gate.lat2) / 2;
  const midLon = (gate.lon1 + gate.lon2) / 2;
  const mLon = metersPerDegLon(midLat);
  const ex = (lon: number) => (lon - midLon) * mLon;
  const ny = (lat: number) => (lat - midLat) * METERS_PER_DEG_LAT;

  const p0x = ex(prev.lon);
  const p0y = ny(prev.lat);
  const p1x = ex(cur.lon);
  const p1y = ny(cur.lat);
  const ax = ex(gate.lon1);
  const ay = ny(gate.lat1);
  const bx = ex(gate.lon2);
  const by = ny(gate.lat2);

  // Intersect path segment P0→P1 against gate segment A→B.
  const rx = p1x - p0x;
  const ry = p1y - p0y;
  const sx = bx - ax;
  const sy = by - ay;
  const denom = rx * sy - ry * sx;

  // Parallel, or one of the two segments is a point — no unique intersection.
  if (Math.abs(denom) < 1e-9) {
    return null;
  }

  const t = ((ax - p0x) * sy - (ay - p0y) * sx) / denom; // along the path
  const u = ((ax - p0x) * ry - (ay - p0y) * rx) / denom; // along the gate
  // Both bounds matter, and for different reasons: `t` outside [0,1] is the
  // infinite line crossing somewhere this hop did not reach, `u` outside [0,1]
  // is the car passing *beside* the gate — through the pits, or across the
  // grass — which is not a lap however cleanly it crosses the line's extension.
  if (t < 0 || t > 1 || u < 0 || u > 1) {
    return null;
  }

  const dirSign: 1 | -1 = denom > 0 ? 1 : -1;
  if (options.requiredDirSign && dirSign !== options.requiredDirSign) {
    return null;
  }

  // Sub-sample interpolation, of the time *and* the point. The point is the
  // load-bearing half: it is what makes consecutive laps' traces share one
  // geographic origin at S/F, without which distance-aligned lap comparison
  // starts each lap up to a fix-interval's travel apart — 5 m at 185 km/h,
  // which is a tenth of a second of phantom delta before the driver has done
  // anything.
  return {
    crossMs: prev.timeMs + t * dtMs,
    lat: prev.lat + t * (cur.lat - prev.lat),
    lon: prev.lon + t * (cur.lon - prev.lon),
    dirSign,
    t,
  };
}

const isPositioned = (fix: CrossingFix): boolean =>
  fix != null &&
  typeof fix.lat === 'number' &&
  typeof fix.lon === 'number' &&
  Number.isFinite(fix.lat) &&
  Number.isFinite(fix.lon);
