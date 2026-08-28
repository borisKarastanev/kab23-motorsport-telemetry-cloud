import { DEFAULT_SECTOR_COUNT } from './sectors';

/**
 * The shared algorithm — written down once at
 * `~/development/optimal-lap-algorithm.md`, implemented natively here and
 * again in the dash's `src/optimallap.{h,cpp}`. Nothing crosses between the
 * two at build or run time; this file is this repo's own reading of the
 * specification, not a port of the other one.
 *
 * Kept free of `Lap`, TypeORM and Nest on purpose, the same discipline
 * `sector-gates.ts` and `sectors.ts` already follow: the rule is one
 * function over a minimal structural input, readable on its own rather than
 * smeared through `AnalysisService`.
 */

export interface SectoredLap {
  lapNumber: number;
  lapMs: number;
  distanceM: number;
  sectorMs: number[];
}

export interface BestSector {
  sector: number;
  lapNumber: number;
  sectorMs: number;
}

export interface OptimalLapCore {
  lapMs: number;
  distanceM: number;
  sectors: BestSector[];
  /** Set when every sector came from one lap — the optimal *is* that lap. */
  matchesLapNumber: number | null;
}

/**
 * The combination of the best sector times across `laps`, or `null` when
 * there is nothing to combine.
 *
 * A lap is eligible only if it recorded a complete, valid set of splits — as
 * many as `sectorCount`, each finite and greater than zero. A lap missing one
 * split is excluded entirely: a partially timed lap has no trustworthy split
 * anywhere, because what looks like one sector's time may be two sectors'
 * worth. With fewer than two eligible laps there is no optimal lap.
 *
 * `distanceM` has no per-sector distance to sum — `SectoredLap` deliberately
 * carries only the lap's total, the same "no trace read" constraint
 * `optimal-lap.ts` documents for braking points — so each winning sector
 * contributes an equal `1/sectorCount` share of its own lap's distance. That
 * is an approximation, consistent with the one the caller makes for braking
 * points, and is superseded by real geometry once a trace is stitched.
 */
export function pickBestSectors(
  laps: SectoredLap[],
  sectorCount: number = DEFAULT_SECTOR_COUNT,
): OptimalLapCore | null {
  const eligible = laps.filter(
    (lap) =>
      lap.sectorMs.length === sectorCount &&
      lap.sectorMs.every((ms) => Number.isFinite(ms) && ms > 0),
  );

  if (eligible.length < 2) {
    return null;
  }

  const sectors: BestSector[] = [];
  for (let i = 0; i < sectorCount; i++) {
    let winner = eligible[0];
    for (const lap of eligible) {
      const better =
        lap.sectorMs[i] < winner.sectorMs[i] ||
        (lap.sectorMs[i] === winner.sectorMs[i] &&
          lap.lapNumber < winner.lapNumber);
      if (better) {
        winner = lap;
      }
    }
    sectors.push({
      sector: i,
      lapNumber: winner.lapNumber,
      sectorMs: winner.sectorMs[i],
    });
  }

  const lapMs = sectors.reduce((sum, sector) => sum + sector.sectorMs, 0);
  const distanceM = sectors.reduce((sum, sector) => {
    const lap = eligible.find((l) => l.lapNumber === sector.lapNumber)!;
    return sum + lap.distanceM / sectorCount;
  }, 0);
  const matchesLapNumber = sectors.every(
    (s) => s.lapNumber === sectors[0].lapNumber,
  )
    ? sectors[0].lapNumber
    : null;

  return { lapMs, distanceM, sectors, matchesLapNumber };
}
