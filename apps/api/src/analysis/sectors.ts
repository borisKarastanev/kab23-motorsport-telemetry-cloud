import { Gate, LapPoint } from './analysis.types';
import { findGateCrossing, projectGate } from './gate-crossing';

/**
 * Sector splits.
 *
 * `sectorTimes` below is the **fallback**: equal fractions of the lap's own
 * distance, used only when no gate set could be resolved for the track (see
 * `sector-gates.ts`). It is honest about what it is, identical for every lap
 * of a session, and gives a genuinely useful lap-vs-lap sector comparison —
 * which is the whole reason anyone reads a sector table — but it is not
 * physically anchored: two laps of slightly different measured distance split
 * at different points on the track.
 *
 * `sectorTimesFromGates` is the real thing: fixed gates, identical for every
 * lap and every session at that track, the same load-bearing property the
 * start/finish line already has.
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
 * One gate's crossing of a lap, in both the time and distance the lap's own
 * `points` already carry.
 *
 * Shared by `sectorTimesFromGates` (which only needs `crossMs`) and
 * `sector-gates.ts` (which also needs `distM`, to check a candidate gate
 * lands near the fraction of the lap it is supposed to). One function so the
 * two never disagree about what "crossed" means — reuses `findGateCrossing`
 * rather than a second crossing test, per this repo's rule that
 * `gate-crossing.ts` is the one place that maths lives.
 */
export interface LapGateCrossing {
  crossMs: number;
  distM: number;
}

/**
 * Every gate in `gates`, each crossed **exactly once**, in order, by `points`
 * — or `null` if any of that fails.
 *
 * No direction constraint: unlike the start/finish gate, a sector gate has no
 * pre-latched racing direction of its own, so a genuine, clean single crossing
 * in either sense of the gate's arbitrary endpoint order counts. What must not
 * happen is two crossings (the car wiggling across the line) or none (a gate
 * that missed the track, or a lap that went off before reaching it) — either
 * is "cannot trust this lap's split here", not a guess at which crossing was
 * the real one.
 */
export function crossGates(
  points: LapPoint[],
  gates: Gate[],
): LapGateCrossing[] | null {
  if (!gates.length || points.length < 2) {
    return null;
  }

  const crossings: LapGateCrossing[] = [];

  for (const gate of gates) {
    const projected = projectGate(gate);
    let found: LapGateCrossing | null = null;
    let count = 0;

    for (let i = 1; i < points.length; i++) {
      const a = points[i - 1];
      const b = points[i];
      const crossing = findGateCrossing(a, b, projected);
      if (crossing) {
        count++;
        found = {
          crossMs: crossing.crossMs,
          distM: a.distM + crossing.t * (b.distM - a.distM),
        };
      }
    }

    if (count !== 1 || !found) {
      return null;
    }
    crossings.push(found);
  }

  // In order and strictly inside the lap: a gate "crossed" before the lap
  // opened or after it closed, or two gates crossed out of sequence, is not a
  // set of splits anyone can read as S1/S2/S3.
  const first = points[0].timeMs;
  const last = points[points.length - 1].timeMs;
  let previous = first;
  for (const crossing of crossings) {
    if (crossing.crossMs <= previous) {
      return null;
    }
    previous = crossing.crossMs;
  }
  if (previous >= last) {
    return null;
  }

  return crossings;
}

/**
 * Per-sector durations from fixed gates, summing to the lap's total elapsed
 * time — the gate-anchored counterpart to `sectorTimes` above.
 *
 * `gates.length` is `sectorCount - 1`: the interior splits only, since the
 * first sector opens and the last closes on the lap's own start/finish
 * crossings, which `points[0]`/`points[points.length - 1]` already are (see
 * `LapSegmenter.closeLap`, which puts the same anchor point at both ends of
 * every lap).
 *
 * Returns `[]` — never a guess — when the lap misses a gate: off-track, a GPS
 * dropout, or a corner cut that never reached the gate's span. `[]` already
 * means "not available" everywhere downstream (`pickBestSectors` excludes such
 * laps), which is also why a partially-timed lap must not report the sectors
 * it *did* cross — see the algorithm specification's eligibility rule.
 */
export function sectorTimesFromGates(
  points: LapPoint[],
  gates: Gate[],
): number[] {
  const crossings = crossGates(points, gates);
  if (!crossings) {
    return [];
  }

  const boundaries = [
    points[0].timeMs,
    ...crossings.map((c) => c.crossMs),
    points[points.length - 1].timeMs,
  ];

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
