import { BrakingPoint, LapPoint } from './analysis.types';
import { round } from './sample-math';

/**
 * Where the driver got on the brakes, and how hard.
 *
 * Braking points are the one derived quantity a driver will argue with, so the
 * detector is deliberately conservative: it reports sustained deceleration, not
 * every dip in the speed trace. A lift off the throttle, a gear change, or one
 * noisy accelerometer sample must not appear as a braking zone next to the
 * three real ones, because a marker that is sometimes noise is a marker nobody
 * trusts.
 */

/** Standard gravity, for converting m/s² to g. */
const G = 9.80665;

/**
 * Deceleration that starts a braking zone. Well above coasting drag and engine
 * braking, comfortably below a real stop from speed — the mock's circuit peaks
 * at 1.19 g under braking, and lifting off produces roughly 0.1 g.
 */
export const BRAKING_ENTER_G = 0.3;

/**
 * Deceleration below which the zone ends — lower than the entry threshold on
 * purpose. Without the hysteresis a single sample dipping under the line, which
 * happens routinely as the driver trail-brakes into the apex, would split one
 * braking event into two markers 20 m apart.
 */
export const BRAKING_EXIT_G = 0.15;

/**
 * How long the deceleration must hold to count.
 *
 * Expressed in milliseconds rather than in samples so the threshold means the
 * same thing whatever rate the data arrived at: 10 Hz from this repo's mock,
 * 25 Hz from a RaceBox, and whatever a replayed session record works out to.
 */
export const MIN_BRAKING_MS = 250;

/**
 * Two zones this close together are one zone with a dip in the middle.
 *
 * The hysteresis above handles a single sample easing off; this handles the
 * driver genuinely coming off the brakes for a tenth of a second between two
 * apexes of the same complex. Measured against the mock's circuit, the gaps
 * that need merging are 100–200 ms and the next-smallest genuine gap is
 * ~900 ms, so the threshold has an order of magnitude of daylight either side
 * rather than being tuned to the boundary.
 *
 * This is not cosmetic. Fragmenting one braking event into three markers 6 m
 * apart makes the marker count swing lap to lap as pace varies, and a marker
 * count that swings is a marker set nobody reads twice.
 */
export const BRAKING_MERGE_MS = 400;

interface OpenZone {
  start: LapPoint;
  end: LapPoint;
  peakDecelG: number;
}

export function detectBrakingPoints(points: LapPoint[]): BrakingPoint[] {
  const zones: OpenZone[] = [];
  let open: OpenZone | null = null;

  for (let i = 1; i < points.length; i++) {
    const decelG = decelerationG(points[i - 1], points[i]);

    if (decelG == null) {
      continue;
    }

    if (!open) {
      if (decelG < BRAKING_ENTER_G) {
        continue;
      }

      const previous = zones[zones.length - 1];
      open =
        previous &&
        points[i - 1].timeMs - previous.end.timeMs <= BRAKING_MERGE_MS
          ? // Reopen the previous zone rather than starting a new one, so the
            // marker stays where the driver first hit the pedal.
            zones.pop()
          : // A new zone starts at the *earlier* of the two points: that is
            // where the driver hit the pedal, and "where they hit the pedal" is
            // what a braking marker is for. Attributing it to the later point
            // would place every marker one sample — up to 5 m — late.
            { start: points[i - 1], end: points[i], peakDecelG: 0 };
    }

    // However the zone came to be open, it now reaches this point. Updated in
    // one place rather than per branch: the merge branch used to skip this and
    // leave `end` where it was before the merge, which is invisible until the
    // merge happens on the last sample of the lap and there is no next
    // iteration to put it right.
    open.peakDecelG = Math.max(open.peakDecelG, decelG);
    open.end = points[i];

    if (decelG < BRAKING_EXIT_G) {
      zones.push(open);
      open = null;
    }
  }

  // A zone still open at the line: the car braked into the last corner and the
  // lap ended before it came off the brakes. Real, so close it at the end.
  if (open) {
    zones.push(open);
  }

  return zones.filter(isSustained).map(toBrakingPoint);
}

const isSustained = (zone: OpenZone): boolean =>
  zone.end.timeMs - zone.start.timeMs >= MIN_BRAKING_MS;

const toBrakingPoint = (zone: OpenZone): BrakingPoint => ({
  distM: round(zone.start.distM, 1),
  lat: zone.start.lat,
  lon: zone.start.lon,
  entrySpeedKmh: round(zone.start.speedKmh ?? 0, 1),
  peakDecelG: round(zone.peakDecelG, 3),
});

/**
 * Deceleration over one interval, in g, positive when slowing.
 *
 * Prefers the measured `gLon` channel and falls back to differentiating speed.
 * The fallback is not a nicety: the `--replay` path for a dash session record
 * carries geometry and lap times with no accelerometer data at all, and a
 * detector that silently returned nothing for those sessions would look like a
 * car that never brakes.
 */
function decelerationG(a: LapPoint, b: LapPoint): number | null {
  // Sign convention matches the wire format: braking is negative gLon.
  if (b.gLon != null) {
    return -b.gLon;
  }

  if (a.speedKmh == null || b.speedKmh == null) {
    return null;
  }

  const dtS = (b.timeMs - a.timeMs) / 1000;
  if (dtS <= 0) {
    return null;
  }

  const dvMs = ((b.speedKmh - a.speedKmh) * 1000) / 3600;
  return -dvMs / dtS / G;
}
