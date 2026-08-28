import { AnalysisSample } from './analysis.types';
import {
  buildLapTrace,
  compareLaps,
  distanceAtElapsed,
  interpolateTracePointAt,
  LapBounds,
} from './lap-trace';
import { LapTracePointDto } from './dto/lap-trace.dto';

const sample = (timeMs: number, overrides: Partial<AnalysisSample> = {}) =>
  ({
    time: new Date(timeMs),
    lat: 42.34,
    lon: 24.73,
    speedKmh: 100,
    ...overrides,
  }) as AnalysisSample;

const point = (
  distM: number,
  elapsedMs: number,
  overrides: Partial<LapTracePointDto> = {},
): LapTracePointDto => ({
  distM,
  elapsedMs,
  lat: 42.34,
  lon: 24.73,
  speedKmh: 100,
  rpm: null,
  coolantC: null,
  oilC: null,
  gLat: null,
  gLon: null,
  ...overrides,
});

describe('buildLapTrace', () => {
  it('returns no trace when nothing is positioned inside or bracketing the window', () => {
    // Every fix lands well after the window closes, so `anchorToLap` finds
    // nothing inside it and nothing to interpolate at either edge either.
    const samples = [sample(5_000), sample(5_100)];
    const bounds: LapBounds = { startMs: 0, endMs: 1_000 };

    expect(buildLapTrace(samples, 1_000, bounds)).toEqual([]);
  });

  it('does not synthesize a duplicate point when a real fix sits on the line', () => {
    // A fix exactly on `startMs`/`endMs` is already carried by the "inside"
    // filter, so interpolating a second point at the same instant would put a
    // zero-length step at either end of the distance axis.
    const samples = [sample(0), sample(500), sample(1_000)];
    const bounds: LapBounds = { startMs: 0, endMs: 1_000 };

    const trace = buildLapTrace(samples, 1_000, bounds);

    expect(trace).toHaveLength(3);
    expect(trace[0].elapsedMs).toBe(0);
    expect(trace[trace.length - 1].elapsedMs).toBe(1_000);
  });

  it('drops the synthesized edge when nothing brackets the crossing', () => {
    // The window opens well before any fix exists, so there is no pair of
    // samples straddling `startMs` to interpolate between — "a trace one
    // sample short", per the function's own comment, not an error.
    const samples = [sample(2_000), sample(2_500), sample(3_000)];
    const bounds: LapBounds = { startMs: 0, endMs: 2_500 };

    const trace = buildLapTrace(samples, 1_000, bounds);

    // Only the two fixes inside [0, 2500] — no synthesized head, and the tail
    // is skipped too because a real fix already sits on endMs.
    expect(trace).toHaveLength(2);
  });
});

describe('interpolateTracePointAt', () => {
  const points = [
    point(0, 0, { speedKmh: 100 }),
    point(100, 1_000, { speedKmh: 120 }),
    point(200, 2_000, { speedKmh: null }),
  ];

  it('interpolates every channel between the bracketing points', () => {
    const at = interpolateTracePointAt(points, 50);

    expect(at.distM).toBe(50);
    expect(at.elapsedMs).toBe(500);
    expect(at.speedKmh).toBe(110);
  });

  it('carries a null channel through rather than inventing a value', () => {
    const at = interpolateTracePointAt(points, 150);
    expect(at.speedKmh).toBeNull();
  });

  it("clamps to the first point below the trace's own range", () => {
    expect(interpolateTracePointAt(points, -10)).toBe(points[0]);
  });

  it("clamps to the last point above the trace's own range", () => {
    expect(interpolateTracePointAt(points, 999)).toBe(points[2]);
  });

  it('returns the only point of a single-point trace', () => {
    expect(interpolateTracePointAt([points[0]], 50)).toBe(points[0]);
  });
});

describe('distanceAtElapsed', () => {
  // Not constant speed: the whole point is that a sector boundary known as a
  // time does not sit at the same fraction of the distance.
  const points = [point(0, 0), point(100, 1_000), point(400, 2_000)];

  it('interpolates between the two points bracketing the instant', () => {
    expect(distanceAtElapsed(points, 500)).toBe(50);
    expect(distanceAtElapsed(points, 1_500)).toBe(250);
  });

  it('lands exactly on a stored point at its own instant', () => {
    expect(distanceAtElapsed(points, 1_000)).toBe(100);
  });

  it("clamps to either end rather than extrapolating past the trace's own", () => {
    expect(distanceAtElapsed(points, -10)).toBe(0);
    expect(distanceAtElapsed(points, 9_999)).toBe(400);
  });

  it('returns the only distance a single-point trace has', () => {
    expect(distanceAtElapsed([points[1]], 0)).toBe(100);
  });
});

describe('compareLaps', () => {
  it('returns nothing when either lap is too short to compare', () => {
    const long = [point(0, 0), point(100, 1_000), point(200, 2_000)];

    expect(compareLaps([], long, 100)).toEqual({ distanceM: 0, points: [] });
    expect(compareLaps([point(0, 0)], long, 100)).toEqual({
      distanceM: 0,
      points: [],
    });
    expect(compareLaps(long, [point(0, 0)], 100)).toEqual({
      distanceM: 0,
      points: [],
    });
  });
});
