import { BrakingPoint } from '../analysis.types';

/** A LapRef that names an actual lap; `'optimal'` is the other spelling. */
export type LapRef = number | 'optimal';

export interface OptimalSectorDto {
  sector: number;
  lapNumber: number;
  sectorMs: number;
}

/**
 * The physical gap, in metres, between two contributing laps' traces at one
 * interior join.
 *
 * Both laps cross the *same* gate, so the gap is not measurement error — it
 * is the two laps crossing that one line at different points across the
 * track's width, a real and bounded quantity. Populated only once a trace has
 * actually been stitched (`stitchOptimalTrace`); the summary carried on
 * `LapsResponseDto.optimal` has no traces to measure it from, so it is always
 * `[]` there.
 */
export interface SeamDto {
  distM: number;
  gapM: number;
}

export interface OptimalLapDto {
  lapMs: number;
  distanceM: number;
  sectors: OptimalSectorDto[];
  brakingPoints: BrakingPoint[];
  matchesLapNumber: number | null;
  seams: SeamDto[];
}
