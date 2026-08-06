import { AnalysisSample } from './analysis.types';
import { LapDeltaPointDto, LapTracePointDto } from './dto/lap-trace.dto';
import { toLapPoints } from './lap-distance';
import { isPositioned, lerpChannel, round } from './sample-math';

/** The interpolated instants a lap opened and closed at, in epoch ms. */
export interface LapBounds {
  startMs: number;
  endMs: number;
}

/**
 * A lap's racing line and channels, on a distance axis.
 *
 * Built from **raw** samples. The Phase 2 `time_bucket` endpoint averages
 * position within a bucket, which puts the car somewhere it never was — fine
 * for a temperature chart, fatal for a racing line, which is exactly the thing
 * that must not be smoothed towards the inside of every corner.
 *
 * `bounds` are the lap's crossing instants. With them — and the bracketing
 * fixes `AnalysisSamplesRepository.findLapWindow` returns — the trace opens and
 * closes *on the start/finish line* rather than at the nearest stored sample.
 * That is what makes two laps' distance axes share an origin, and so what makes
 * `compareLaps` measure driving rather than sampling phase. It is also what
 * makes the last point's `elapsedMs` agree with the lap's own `lapMs`.
 *
 * The distance axis comes from `toLapPoints`, not from a loop of its own: the
 * number a braking point was stored at and the number the map draws it at have
 * to be the same number, and the only way to be sure of that is for there to be
 * one implementation.
 */
export function buildLapTrace(
  samples: AnalysisSample[],
  maxPoints: number,
  bounds: LapBounds,
): LapTracePointDto[] {
  const located = anchorToLap(samples.filter(isPositioned), bounds);

  if (!located.length) {
    return [];
  }

  const originMs = located[0].time.getTime();
  // Index-parallel to `located` — both drop exactly the fixes with no position,
  // and `located` has none left.
  const axis = toLapPoints(located);

  const points = located.map((sample, i) => ({
    distM: axis[i].distM,
    elapsedMs: sample.time.getTime() - originMs,
    lat: sample.lat,
    lon: sample.lon,
    speedKmh: sample.speedKmh ?? null,
    rpm: sample.rpm ?? null,
    coolantC: sample.coolantC ?? null,
    oilC: sample.oilC ?? null,
    gLat: sample.gLat ?? null,
    gLon: sample.gLon ?? null,
  }));

  return decimateByDistance(points, maxPoints);
}

/**
 * Clip a window of samples to a lap, with a synthesized fix at each crossing.
 *
 * The same anchor `LapSegmenter` put on both sides of the line when it derived
 * the lap, rebuilt here from the stored samples. Reconstructed rather than
 * persisted because it is a function of rows that already exist: storing it
 * would add a second copy of the trace's endpoints that could drift from them.
 */
function anchorToLap(
  located: AnalysisSample[],
  { startMs, endMs }: LapBounds,
): AnalysisSample[] {
  const inside = located.filter((sample) => {
    const timeMs = sample.time.getTime();
    return timeMs >= startMs && timeMs <= endMs;
  });

  // A window with no fix either side of the crossing — the first lap of a
  // session that began on the line, or a gap in the data — anchors on what it
  // has. Better a trace one sample short than no trace at all.
  const head = interpolateAt(located, startMs);
  const tail = interpolateAt(located, endMs);

  return [...(head ? [head] : []), ...inside, ...(tail ? [tail] : [])];
}

/**
 * A synthesized sample at `atMs`, interpolated between the two fixes that
 * bracket it.
 *
 * Null when nothing brackets it, and null when a real sample already sits on
 * the instant — that one is inside the lap and adding a copy of it would put a
 * zero-length step at the head of the distance axis.
 */
function interpolateAt(
  located: AnalysisSample[],
  atMs: number,
): AnalysisSample | null {
  for (let i = 0; i < located.length - 1; i++) {
    const aMs = located[i].time.getTime();
    const bMs = located[i + 1].time.getTime();

    if (aMs === atMs || bMs === atMs) {
      return null;
    }
    if (aMs > atMs || bMs < atMs) {
      continue;
    }

    const a = located[i];
    const b = located[i + 1];
    const t = (atMs - aMs) / (bMs - aMs);

    return {
      time: new Date(atMs),
      lat: a.lat + t * (b.lat - a.lat),
      lon: a.lon + t * (b.lon - a.lon),
      speedKmh: lerpChannel(a.speedKmh, b.speedKmh, t),
      rpm: lerpChannel(a.rpm, b.rpm, t),
      coolantC: lerpChannel(a.coolantC, b.coolantC, t),
      oilC: lerpChannel(a.oilC, b.oilC, t),
      gLat: lerpChannel(a.gLat, b.gLat, t),
      gLon: lerpChannel(a.gLon, b.gLon, t),
    };
  }

  return null;
}

/**
 * Thin a trace to a point budget, at even spacing **along the track**.
 *
 * By distance rather than by index because a lap spends most of its samples
 * where the car is slowest — dropping every Nth sample thins the straights and
 * the hairpin equally, which is backwards: the straight is two points' worth of
 * information and the hairpin is the shape of the lap.
 *
 * Ramer–Douglas–Peucker would adapt further, keeping corner vertices and
 * collapsing straights to their endpoints, and it was considered. It is not
 * needed at these budgets, and the arithmetic says so: the default 1 000 points
 * over a 2 100 m lap is 2.1 m spacing, and a 2.1 m chord across the tightest
 * corner on the mock's circuit — 32.5 m radius — departs from the arc by
 * `r - sqrt(r² - (d/2)²)` ≈ **17 mm**. RDP would buy back points a map cannot
 * resolve, in exchange for an output size no caller can predict.
 */
export function decimateByDistance(
  points: LapTracePointDto[],
  maxPoints: number,
): LapTracePointDto[] {
  if (points.length <= maxPoints || maxPoints < 2) {
    return points;
  }

  const totalM = points[points.length - 1].distM;
  const spacing = totalM / (maxPoints - 1);
  const kept: LapTracePointDto[] = [points[0]];
  let nextM = spacing;

  for (let i = 1; i < points.length - 1; i++) {
    if (points[i].distM >= nextM) {
      kept.push(points[i]);
      // Advance past every threshold this point cleared, so one long gap
      // between fixes cannot leave the budget permanently behind and turn the
      // rest of the lap into a full-rate dump.
      nextM = (Math.floor(points[i].distM / spacing) + 1) * spacing;
    }
  }

  // The closing point is the crossing of the line. Dropping it would end every
  // trace somewhere short of S/F.
  kept.push(points[points.length - 1]);
  return kept;
}

/**
 * Lap B measured against lap A, on a shared distance axis.
 *
 * **Distance-aligned, not time-aligned**, which is the whole idea: two laps of
 * different duration have no common time axis, and the question a driver is
 * asking is "where did I lose it", not "what was I doing at 31 seconds".
 *
 * The axis stops at the shorter lap's distance. Extrapolating the shorter one
 * past its own end would produce delta from arithmetic rather than from driving.
 */
export function compareLaps(
  a: LapTracePointDto[],
  b: LapTracePointDto[],
  maxPoints: number,
): { distanceM: number; points: LapDeltaPointDto[] } {
  if (a.length < 2 || b.length < 2) {
    return { distanceM: 0, points: [] };
  }

  const distanceM = Math.min(a[a.length - 1].distM, b[b.length - 1].distM);
  const steps = Math.max(Math.min(maxPoints, 5000), 2);
  const points: LapDeltaPointDto[] = [];
  // Both traces and the axis ascend together, so each lookup resumes where the
  // last one stopped: the whole comparison is one pass over each lap rather
  // than a scan per step.
  const cursorA = { index: 0 };
  const cursorB = { index: 0 };

  for (let i = 0; i < steps; i++) {
    const distM = (distanceM * i) / (steps - 1);
    const atA = sampleAtDistance(a, distM, cursorA);
    const atB = sampleAtDistance(b, distM, cursorB);

    points.push({
      distM: round(distM, 1),
      elapsedAMs: Math.round(atA.elapsedMs),
      elapsedBMs: Math.round(atB.elapsedMs),
      deltaMs: Math.round(atB.elapsedMs - atA.elapsedMs),
      speedAKmh: atA.speedKmh,
      speedBKmh: atB.speedKmh,
    });
  }

  return { distanceM: round(distanceM, 1), points };
}

/**
 * Elapsed time and speed at a given distance, interpolated between the two
 * points that bracket it.
 *
 * `cursor` is where the previous lookup finished. It is the caller's, not a
 * cache keyed on the array: a cursor that outlived one comparison would start
 * the next one halfway down the lap.
 */
function sampleAtDistance(
  points: LapTracePointDto[],
  distM: number,
  cursor: { index: number },
): { elapsedMs: number; speedKmh: number | null } {
  let i = cursor.index;

  while (i < points.length - 1 && points[i + 1].distM < distM) {
    i++;
  }
  cursor.index = i;

  const from = points[i];
  const to = points[Math.min(i + 1, points.length - 1)];
  const span = to.distM - from.distM;
  const t =
    span > 0 ? Math.min(Math.max((distM - from.distM) / span, 0), 1) : 0;

  return {
    elapsedMs: from.elapsedMs + t * (to.elapsedMs - from.elapsedMs),
    speedKmh:
      from.speedKmh == null || to.speedKmh == null
        ? (from.speedKmh ?? to.speedKmh ?? null)
        : round(from.speedKmh + t * (to.speedKmh - from.speedKmh), 2),
  };
}
