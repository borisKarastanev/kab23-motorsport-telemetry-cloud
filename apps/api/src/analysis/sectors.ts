import { LapPoint } from './analysis.types';

/**
 * Sector splits.
 *
 * **These are equal fractions of the lap's distance, not gates.** No track
 * database this platform can reach carries split points, and inventing
 * coordinates for them would produce sector times that look authoritative and
 * mean nothing. Equal-distance thirds are honest about what they are, are
 * identical for every lap of a session, and therefore give a genuinely useful
 * lap-vs-lap sector comparison — which is the whole reason anyone reads a
 * sector table.
 *
 * `Track.sectorGates` exists for the day someone has real split points; when it
 * is populated the derivation reads gates and this becomes the fallback. That
 * day is not today (see the column's own comment).
 */

export const DEFAULT_SECTOR_COUNT = 3;

/**
 * Per-sector durations, in order, summing to the lap's total elapsed time.
 *
 * Splits are placed at fixed fractions of the lap's *own* distance rather than
 * of a reference lap's, so a lap driven wide still splits at the same fraction
 * of the way round rather than drifting a sector boundary into a corner.
 */
export function sectorTimes(
  points: LapPoint[],
  sectorCount: number = DEFAULT_SECTOR_COUNT,
): number[] {
  if (sectorCount < 1 || points.length < 2) {
    return [];
  }

  const first = points[0];
  const last = points[points.length - 1];
  const totalM = last.distM - first.distM;
  const totalMs = last.timeMs - first.timeMs;

  // A lap with no measured distance (every fix at the same place) has nothing
  // to split on. Returning [] beats returning three zeros, which would read as
  // three instantaneous sectors rather than as "not available".
  if (totalM <= 0 || totalMs <= 0) {
    return [];
  }

  const boundaries: number[] = [first.timeMs];
  for (let i = 1; i < sectorCount; i++) {
    boundaries.push(
      timeAtDistance(points, first.distM + (totalM * i) / sectorCount),
    );
  }
  boundaries.push(last.timeMs);

  return boundaries.slice(1).map((end, i) => Math.round(end - boundaries[i]));
}

/**
 * When the car reached a given cumulative distance, interpolated between the
 * two points that bracket it.
 *
 * Interpolated rather than snapped to the nearer point because at 10 Hz and
 * 185 km/h consecutive points are 5 m apart: snapping would quantise every
 * sector boundary to ±100 ms, which is the same order as the sector-to-sector
 * differences the table exists to show.
 */
function timeAtDistance(points: LapPoint[], targetM: number): number {
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1];
    const b = points[i];

    if (b.distM < targetM) {
      continue;
    }

    const span = b.distM - a.distM;
    const t = span > 0 ? (targetM - a.distM) / span : 0;
    return a.timeMs + t * (b.timeMs - a.timeMs);
  }

  return points[points.length - 1].timeMs;
}
