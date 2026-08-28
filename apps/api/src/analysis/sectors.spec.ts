import { Gate, LapPoint } from './analysis.types';
import { crossGates, sectorTimes, sectorTimesFromGates } from './sectors';

/**
 * A lap driven at a constant `speedKmh` in a straight line, sampled at 10 Hz.
 *
 * Straight and constant on purpose: with distance and time proportional, the
 * correct sector split is arithmetic, so the test asserts against a number
 * derived by hand rather than against whatever the implementation happens to
 * return.
 */
function evenLap(totalM: number, speedKmh: number, dtMs = 100): LapPoint[] {
  const stepM = ((speedKmh * 1000) / 3600) * (dtMs / 1000);
  const points: LapPoint[] = [];

  for (let distM = 0; distM <= totalM + 1e-9; distM += stepM) {
    points.push({
      timeMs: (distM / stepM) * dtMs,
      lat: 42.34 + distM / 111132,
      lon: 24.73,
      distM,
      speedKmh,
    });
  }

  return points;
}

describe('sectorTimes', () => {
  it('splits an even lap into equal sectors', () => {
    const lap = evenLap(1800, 108); // 30 m/s → 60 s
    const sectors = sectorTimes(lap, 3);

    expect(sectors).toHaveLength(3);
    for (const sector of sectors) {
      expect(sector).toBeCloseTo(20_000, -1);
    }
  });

  it('sums to the lap time exactly', () => {
    // The lap table shows sectors beside the lap time. If they do not add up,
    // one of the two numbers is wrong and the reader cannot tell which.
    const lap = evenLap(2100, 118);
    const lapMs = lap[lap.length - 1].timeMs - lap[0].timeMs;

    const sum = sectorTimes(lap, 3).reduce((a, b) => a + b, 0);
    expect(Math.abs(sum - lapMs)).toBeLessThanOrEqual(2);
  });

  it('splits on distance, not on time', () => {
    // The distinguishing case: a car that crawls the first half of the lap and
    // sprints the second. Splitting on time would put the boundary halfway
    // round in *seconds*, which is nowhere near halfway round the track — and
    // a sector that means a different piece of tarmac on every lap compares
    // nothing.
    const slow = evenLap(500, 36); // 500 m at 10 m/s → 50 s
    const fastStart = slow[slow.length - 1];
    const fast = evenLap(500, 180).map((point) => ({
      ...point,
      timeMs: point.timeMs + fastStart.timeMs,
      distM: point.distM + fastStart.distM,
    }));

    const [first, second] = sectorTimes([...slow, ...fast.slice(1)], 2);

    // Halfway by distance is the end of the slow half: 50 s against 10 s.
    expect(first).toBeCloseTo(50_000, -2);
    expect(second).toBeCloseTo(10_000, -2);
  });

  it('honours a sector count other than three', () => {
    expect(sectorTimes(evenLap(1800, 108), 5)).toHaveLength(5);
    expect(sectorTimes(evenLap(1800, 108), 1)).toHaveLength(1);
  });

  it.each([
    ['a lap with one point', [{ timeMs: 0, lat: 42, lon: 24, distM: 0 }]],
    ['an empty lap', []],
  ])('returns nothing for %s', (_label, points) => {
    expect(sectorTimes(points as LapPoint[], 3)).toEqual([]);
  });

  it('returns nothing for a lap that covered no distance', () => {
    // A car parked with the engine running: real samples, real elapsed time,
    // no lap. Three zeros would read as three instantaneous sectors; nothing
    // reads as "not available", which is the truth.
    const parked: LapPoint[] = Array.from({ length: 10 }, (_, i) => ({
      timeMs: i * 100,
      lat: 42.34,
      lon: 24.73,
      distM: 0,
      speedKmh: 0,
    }));

    expect(sectorTimes(parked, 3)).toEqual([]);
  });
});

/** A gate perpendicular to `evenLap`'s path (due north) at `distM`. */
function gateAt(distM: number): Gate {
  const lat = 42.34 + distM / 111132;
  return { lat1: lat, lon1: 24.72, lat2: lat, lon2: 24.74 };
}

// `evenLap(1800, 108)` steps by exactly 3 m (30 m/s at 100 ms). Gates offset
// by half a step so a boundary never lands exactly on a sampled vertex, where
// the incoming and outgoing segments can both register a crossing at the
// shared point — a real edge case for an exact split, not one real GPS floats
// hit.
describe('sectorTimesFromGates', () => {
  it('splits at the gates, summing to the lap time', () => {
    const lap = evenLap(1800, 108); // 60 s lap
    const lapMs = lap[lap.length - 1].timeMs - lap[0].timeMs;

    const sectors = sectorTimesFromGates(lap, [gateAt(601.5), gateAt(1201.5)]);

    expect(sectors).toHaveLength(3);
    for (const sector of sectors) {
      expect(Math.abs(sector - 20_000)).toBeLessThanOrEqual(50);
    }
    expect(
      Math.abs(sectors.reduce((a, b) => a + b, 0) - lapMs),
    ).toBeLessThanOrEqual(2);
  });

  it('honours a gate count other than two', () => {
    const lap = evenLap(1800, 108);
    expect(sectorTimesFromGates(lap, [gateAt(901.5)])).toHaveLength(2);
  });

  it('returns [] when a gate is never crossed', () => {
    const lap = evenLap(1800, 108);
    const nowhereNear: Gate = { lat1: 10, lon1: 10, lat2: 10, lon2: 10.01 };

    expect(sectorTimesFromGates(lap, [gateAt(601.5), nowhereNear])).toEqual([]);
  });

  it('returns [] when gates are crossed out of order', () => {
    const lap = evenLap(1800, 108);
    // Second gate physically before the first: their crossing instants come
    // back in the wrong order, which is not a set of splits anyone can read
    // as S1/S2/S3.
    expect(sectorTimesFromGates(lap, [gateAt(1201.5), gateAt(601.5)])).toEqual(
      [],
    );
  });

  it('returns [] when a gate is crossed more than once', () => {
    // A car wiggling back and forth across the line — GPS jitter, or a
    // genuine off that rejoined behind it.
    const wiggle: LapPoint[] = [
      { timeMs: 0, lat: 42.34 + 590 / 111132, lon: 24.73, distM: 590 },
      { timeMs: 400, lat: 42.34 + 610 / 111132, lon: 24.73, distM: 610 },
      { timeMs: 800, lat: 42.34 + 590 / 111132, lon: 24.73, distM: 620 },
      { timeMs: 1200, lat: 42.34 + 610 / 111132, lon: 24.73, distM: 630 },
    ];

    expect(sectorTimesFromGates(wiggle, [gateAt(600)])).toEqual([]);
  });

  it("returns [] when the only gate sits exactly on the lap's closing point", () => {
    // A degenerate placement — the "boundary" is not a boundary at all if
    // nothing of the lap remains after it.
    const lap = evenLap(1800, 108);
    expect(sectorTimesFromGates(lap, [gateAt(1800)])).toEqual([]);
  });

  it('returns [] for a lap with fewer than two points', () => {
    expect(
      sectorTimesFromGates([evenLap(1800, 108)[0]], [gateAt(600)]),
    ).toEqual([]);
  });
});

describe('crossGates', () => {
  it('returns null for an empty gate list', () => {
    expect(crossGates(evenLap(1800, 108), [])).toBeNull();
  });

  it('carries the crossing distance alongside the time', () => {
    const lap = evenLap(1800, 108);
    const crossings = crossGates(lap, [gateAt(601.5)]);

    expect(crossings).not.toBeNull();
    expect(crossings![0].distM).toBeCloseTo(601.5, 0);
  });
});
