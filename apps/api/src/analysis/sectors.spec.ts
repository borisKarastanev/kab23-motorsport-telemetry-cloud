import { LapPoint } from './analysis.types';
import { sectorTimes } from './sectors';

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
