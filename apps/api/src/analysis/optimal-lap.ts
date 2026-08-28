import { BrakingPoint } from './analysis.types';
import { distanceM } from './geo';
import {
  decimateByDistance,
  distanceAtElapsed,
  interpolateTracePointAt,
} from './lap-trace';
import { LapTracePointDto } from './dto/lap-trace.dto';
import { OptimalLapDto, SeamDto } from './dto/optimal-lap.dto';
import { pickBestSectors, SectoredLap } from './optimal-lap-core';
import { round } from './sample-math';

/**
 * The cloud-only half of the optimal lap: everything §1b of the plan and the
 * shared specification leave to each project's own business — geometry,
 * braking points, and how the line gets drawn.
 */

/**
 * A lap as this module reads one: its splits, plus the braking points to
 * rebase.
 *
 * Structural rather than the `Lap` entity, the same discipline
 * `optimal-lap-core.ts` states for itself and `sector-gates.ts` follows — a
 * file implementing a specification the dash mirrors in C++ has no business
 * dragging a decorated TypeORM class through to describe four fields. `Lap`
 * satisfies it as it stands, so the call sites pass their rows unchanged.
 */
export interface OptimalLapInput extends SectoredLap {
  brakingPoints: BrakingPoint[];
}

/**
 * The session's optimal lap, from rows `AnalysisService` already holds.
 *
 * **No trace read.** `Lap.brakingPoints[].distM` is already on that lap's own
 * distance axis, so rebasing it onto the stitched axis needs only the lap
 * rows themselves — fetching a trace per contributing lap here would be the
 * "extra query and extra round trip" the response is specifically built to
 * avoid (see `AnalysisService.respond`). The rebasing therefore uses the same
 * equal-fraction distance split `pickBestSectors` already assumes for
 * `distanceM`, not the exact gate-crossing distances a stitched trace would
 * give — see `stitchOptimalTrace` for where that approximation is replaced by
 * real geometry.
 */
export function buildOptimalLap(laps: OptimalLapInput[]): OptimalLapDto | null {
  const core = pickBestSectors(laps);
  if (!core) {
    return null;
  }

  const sectorCount = core.sectors.length;
  const byLapNumber = new Map(laps.map((lap) => [lap.lapNumber, lap]));

  const brakingPoints: BrakingPoint[] = [];
  let cumulativeM = 0;
  for (const sector of core.sectors) {
    const lap = byLapNumber.get(sector.lapNumber)!;
    const step = lap.distanceM / sectorCount;
    const fromM = step * sector.sector;
    const toM = step * (sector.sector + 1);
    const isLastSector = sector.sector === sectorCount - 1;

    for (const bp of lap.brakingPoints) {
      const inRange = isLastSector
        ? bp.distM >= fromM && bp.distM <= toM
        : bp.distM >= fromM && bp.distM < toM;
      if (inRange) {
        brakingPoints.push({
          ...bp,
          distM: round(cumulativeM + (bp.distM - fromM), 1),
        });
      }
    }

    cumulativeM += step;
  }

  return {
    lapMs: core.lapMs,
    distanceM: core.distanceM,
    sectors: core.sectors,
    brakingPoints,
    matchesLapNumber: core.matchesLapNumber,
    // No trace has been read yet — nothing to measure a physical gap from.
    // `stitchOptimalTrace` fills this in, on the caller's own copy of `plan`.
    seams: [],
  };
}

/** One contributing lap, as the stitch needs it: its trace and its splits. */
export interface ContributingLap {
  /** That lap's own per-sector times, in order — where its boundaries are. */
  sectorMs: number[];
  points: LapTracePointDto[];
}

/**
 * The optimal lap's racing line: each sector's geometry sliced from the trace
 * of the lap that set it, stitched onto one cumulative axis.
 *
 * **Each slice is cut where that lap's own sector actually ended**, not at an
 * equal fraction of its distance. The boundary instant is the running sum of
 * the lap's own `sectorMs` — which, on a gate-derived session, *is* the instant
 * it crossed the gate — converted to a distance along its trace by
 * `distanceAtElapsed`. Cutting at `k/N` of the distance instead was a real
 * mismatch, not a rounding one: `sector-gates.ts` accepts a gate up to
 * `SANE_BAND_FACTOR` (0.4) of a sector from its nominal fraction, so a
 * perfectly valid gate 1 can sit at 20% of the lap while the splice went in at
 * 33.3% — a join a tenth of a lap away from the gate that produced the time,
 * under a caption (`optimalCaption`) that promises nothing is approximate on a
 * gate-derived session. It also skewed the time rescale below, mapping a
 * 20%-of-distance sector time onto 33.3% of geometry.
 *
 * Each slice is then clipped at an **interpolated point at each boundary**
 * (`interpolateTracePointAt`, the same bracketing interpolation `lap-trace.ts`
 * already uses elsewhere) rather than at whichever raw sample happens to sit
 * nearest — a crossing is a specific instant no stored sample is guaranteed to
 * land on.
 *
 * Time within a segment is still **rescaled to the sector's own authoritative
 * `sectorMs`**. With boundaries cut at the right place the raw span is already
 * within a sample of it, but the two are independently rounded, and only the
 * rescale makes the stitched lap's total agree with `plan.lapMs` to the
 * millisecond.
 *
 * **All or nothing.** A sector whose contributing lap has no readable trace
 * used to be skipped while its time still counted, which returned a trace
 * covering two thirds of the distance whose last point claimed the full
 * three-sector time — a several-second cliff on the delta chart, and a
 * `distanceM` short by a third, both reported as complete. There is no partial
 * optimal lap: `[]` comes back and the caller 404s, as `buildOptimalLap`
 * already does when it cannot build a plan at all.
 *
 * `plan.seams` is **mutated in place** with each interior join's physical
 * gap — the two contributing laps' positions at what is nominally the same
 * point on the track, genuinely different because they are different laps.
 * `plan` is `AnalysisService`'s own fresh `buildOptimalLap` result for this
 * call, never a cached or shared one, so mutating it is not a hidden side
 * effect on anything else.
 */
export function stitchOptimalTrace(
  plan: OptimalLapDto,
  contributingByLap: Map<number, ContributingLap>,
  maxPoints: number,
): LapTracePointDto[] {
  const sectorCount = plan.sectors.length;
  const usable = plan.sectors.every(
    (sector) =>
      (contributingByLap.get(sector.lapNumber)?.points.length ?? 0) >= 2,
  );
  if (!usable) {
    return [];
  }

  const stitched: LapTracePointDto[] = [];
  let cumulativeDistM = 0;
  let cumulativeElapsedMs = 0;

  plan.sectors.forEach((sector, i) => {
    const { sectorMs, points: trace } = contributingByLap.get(sector.lapNumber);

    const [fromM, toM] = sectorBoundsM(trace, sectorMs, i, sectorCount);
    const startPoint = interpolateTracePointAt(trace, fromM);
    const endPoint = interpolateTracePointAt(trace, toM);

    recordSeam(plan.seams, stitched, startPoint, cumulativeDistM);

    const rawSpanMs = endPoint.elapsedMs - startPoint.elapsedMs || 1;
    const scale = sector.sectorMs / rawSpanMs;
    const interior = trace.filter((p) => p.distM > fromM && p.distM < toM);

    for (const point of [startPoint, ...interior, endPoint]) {
      stitched.push({
        distM: round(cumulativeDistM + (point.distM - fromM), 1),
        elapsedMs: Math.round(
          cumulativeElapsedMs +
            (point.elapsedMs - startPoint.elapsedMs) * scale,
        ),
        lat: point.lat,
        lon: point.lon,
        speedKmh: point.speedKmh,
        rpm: point.rpm,
        coolantC: point.coolantC,
        oilC: point.oilC,
        gLat: point.gLat,
        gLon: point.gLon,
      });
    }

    cumulativeDistM += toM - fromM;
    cumulativeElapsedMs += sector.sectorMs;
  });

  // The rescale above keeps every interior point close to the mark, but only
  // the true final point is pinned exactly — that is the one `lapMs` and the
  // trace's own last elapsed value must agree on to the millisecond.
  if (stitched.length) {
    const last = stitched[stitched.length - 1];
    stitched[stitched.length - 1] = {
      ...last,
      distM: round(cumulativeDistM, 1),
      elapsedMs: plan.lapMs,
    };
  }

  return decimateByDistance(stitched, maxPoints);
}

/**
 * Where sector `i` starts and ends along one contributing lap's trace.
 *
 * From that lap's own splits: the boundary is the running sum of `sectorMs`,
 * an elapsed instant, turned into a distance by `distanceAtElapsed`. The first
 * and last boundaries are pinned to the trace's own ends rather than computed,
 * since the lap opens and closes on the start/finish line by construction and
 * a millisecond of rounding must not clip either end off the line.
 *
 * Falls back to equal distance fractions when the lap has no usable split set.
 * `pickBestSectors` only ever picks laps with a complete one, so this is a
 * guard rather than a path — but the wrong answer here is a mis-drawn line, and
 * the fallback at least matches what the times were measured on.
 */
function sectorBoundsM(
  trace: LapTracePointDto[],
  sectorMs: number[],
  i: number,
  sectorCount: number,
): [fromM: number, toM: number] {
  const lapDistanceM = trace[trace.length - 1].distM;

  if (sectorMs?.length !== sectorCount) {
    return [
      (lapDistanceM * i) / sectorCount,
      (lapDistanceM * (i + 1)) / sectorCount,
    ];
  }

  const boundaryM = (k: number): number => {
    if (k === 0) {
      return trace[0].distM;
    }
    if (k === sectorCount) {
      return lapDistanceM;
    }
    const atMs = sectorMs.slice(0, k).reduce((sum, ms) => sum + ms, 0);
    return distanceAtElapsed(trace, atMs);
  };

  return [boundaryM(i), boundaryM(i + 1)];
}

function recordSeam(
  seams: SeamDto[],
  stitchedSoFar: LapTracePointDto[],
  startPoint: LapTracePointDto,
  atDistM: number,
): void {
  const previousEnd = stitchedSoFar[stitchedSoFar.length - 1];
  if (!previousEnd) {
    return;
  }

  const gapM = distanceM(
    previousEnd.lat,
    previousEnd.lon,
    startPoint.lat,
    startPoint.lon,
  );
  seams.push({ distM: round(atDistM, 1), gapM: round(gapM, 2) });
}
