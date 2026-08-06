import { Gate } from './analysis.types';
import {
  CrossingFix,
  MAX_FIX_GAP_MS,
  STATIONARY_SPEED_KMH,
  findGateCrossing,
  projectGate,
} from './gate-crossing';
import { localFrame } from './geo';

/**
 * Kaloyanovo's confirmed start/finish gate — the real one, from
 * `tracks.seed.ts`, not a synthetic line at the origin.
 *
 * It matters that these are real coordinates: a gate at (0, 0) with a length of
 * one degree would pass a test that a 17.7 m line at latitude 42 fails, because
 * the whole risk in this maths is precision at track scale.
 */
const RAW_GATE: Gate = {
  lat1: 42.3411288,
  lon1: 24.737,
  lat2: 42.3409841,
  lon2: 24.7369101,
};

/**
 * `findGateCrossing` takes the gate already projected — it runs once per
 * consecutive pair of fixes, and the projection depends on nothing but the
 * gate. `LapSegmenter` does this once in its constructor.
 */
const GATE = projectGate(RAW_GATE);

const frame = localFrame(
  (RAW_GATE.lat1 + RAW_GATE.lat2) / 2,
  (RAW_GATE.lon1 + RAW_GATE.lon2) / 2,
);
const A = frame.toLocal(RAW_GATE.lat1, RAW_GATE.lon1);
const B = frame.toLocal(RAW_GATE.lat2, RAW_GATE.lon2);
const along = { x: B.x - A.x, y: B.y - A.y };
const gateLenM = Math.hypot(along.x, along.y);
const unit = { x: along.x / gateLenM, y: along.y / gateLenM };
/** Unit normal to the gate — the direction a car actually crosses it in. */
const across = { x: -unit.y, y: unit.x };

interface PathOptions {
  /** Fraction along the gate the path aims at. Outside [0,1] misses it. */
  u?: number;
  /** Metres before / after the line the two fixes sit. */
  beforeM?: number;
  afterM?: number;
  startMs?: number;
  dtMs?: number;
  /** Drive the other way through the line. */
  reverse?: boolean;
  speedKmh?: number;
  /** Travel along the gate rather than across it. */
  parallel?: boolean;
}

/** A pair of consecutive fixes on a straight path through (or past) the gate. */
function path({
  u = 0.5,
  beforeM = 10,
  afterM = 10,
  startMs = 0,
  dtMs = 100,
  reverse = false,
  speedKmh = 120,
  parallel = false,
}: PathOptions = {}): [CrossingFix, CrossingFix] {
  const aim = { x: A.x + along.x * u, y: A.y + along.y * u };
  const heading = parallel ? unit : across;
  const sign = reverse ? -1 : 1;

  const p0 = frame.toGeo(
    aim.x - heading.x * beforeM * sign,
    aim.y - heading.y * beforeM * sign,
  );
  const p1 = frame.toGeo(
    aim.x + heading.x * afterM * sign,
    aim.y + heading.y * afterM * sign,
  );

  return [
    { timeMs: startMs, lat: p0.lat, lon: p0.lon, speedKmh },
    { timeMs: startMs + dtMs, lat: p1.lat, lon: p1.lon, speedKmh },
  ];
}

/** Metres between a returned crossing point and where it should have been. */
function errorM(crossing: { lat: number; lon: number }, u: number): number {
  const expected = { x: A.x + along.x * u, y: A.y + along.y * u };
  const actual = frame.toLocal(crossing.lat, crossing.lon);
  return Math.hypot(actual.x - expected.x, actual.y - expected.y);
}

describe('findGateCrossing', () => {
  it('detects a clean transversal crossing', () => {
    const crossing = findGateCrossing(...path(), GATE);

    expect(crossing).not.toBeNull();
    expect(crossing.t).toBeCloseTo(0.5, 6);
    expect(crossing.crossMs).toBeCloseTo(50, 6);
    // Centimetre-level, on a 17.7 m gate at latitude 42.
    expect(errorM(crossing, 0.5)).toBeLessThan(0.01);
  });

  it('interpolates the crossing time and point sub-sample', () => {
    // The car is 5 m short of the line at the first fix and 15 m past it at
    // the second, so it crossed a quarter of the way through the interval —
    // not at either fix, which is what a naive implementation would report.
    const crossing = findGateCrossing(
      ...path({ beforeM: 5, afterM: 15, u: 0.4, dtMs: 100 }),
      GATE,
    );

    expect(crossing.t).toBeCloseTo(0.25, 6);
    expect(crossing.crossMs).toBeCloseTo(25, 6);
    expect(errorM(crossing, 0.4)).toBeLessThan(0.01);
  });

  it.each([
    ['past the far endpoint', 1.4],
    ['past the near endpoint', -0.4],
  ])('rejects a pass beside the gate, %s', (_label, u) => {
    // The car crosses the gate's infinite *line* cleanly — through the pits,
    // or across the grass — but not the gate itself. This is the check that
    // stops a paddock lap from counting.
    expect(findGateCrossing(...path({ u }), GATE)).toBeNull();
  });

  it('rejects a hop that never reaches the line', () => {
    // Both fixes on the approach side: t > 1.
    expect(
      findGateCrossing(...path({ beforeM: 30, afterM: -10 }), GATE),
    ).toBeNull();
  });

  it('reports opposite direction signs for opposite crossings', () => {
    const forward = findGateCrossing(...path(), GATE);
    const backward = findGateCrossing(...path({ reverse: true }), GATE);

    expect(forward.dirSign).toBe(-backward.dirSign);
  });

  it('rejects a crossing against the latched racing direction', () => {
    const racing = findGateCrossing(...path(), GATE).dirSign;

    // Same geometry, driven the other way: the pit-lane side of the line, or a
    // car reversing out of a spin. Not a lap.
    expect(
      findGateCrossing(...path({ reverse: true }), GATE, {
        requiredDirSign: racing,
      }),
    ).toBeNull();

    // And the racing direction still counts, so the latch is not just a
    // blanket reject.
    expect(
      findGateCrossing(...path(), GATE, { requiredDirSign: racing }),
    ).not.toBeNull();
  });

  it('rejects a path parallel to the gate', () => {
    // Driving along the line rather than through it: the intersection maths is
    // degenerate here, and without the guard `denom` near zero would produce a
    // wild `t`.
    expect(findGateCrossing(...path({ parallel: true }), GATE)).toBeNull();
  });

  it('rejects a degenerate gate', () => {
    const point: Gate = {
      lat1: RAW_GATE.lat1,
      lon1: RAW_GATE.lon1,
      lat2: RAW_GATE.lat1,
      lon2: RAW_GATE.lon1,
    };

    expect(findGateCrossing(...path(), projectGate(point))).toBeNull();
  });

  it('rejects fixes too far apart in time to bridge', () => {
    // A stall in the uplink, not a lap. Interpolating a straight line across
    // it would invent a path — and near the gate, invent a crossing.
    expect(
      findGateCrossing(...path({ dtMs: MAX_FIX_GAP_MS + 1 }), GATE),
    ).toBeNull();
    expect(
      findGateCrossing(...path({ dtMs: MAX_FIX_GAP_MS }), GATE),
    ).not.toBeNull();
  });

  it.each([0, -1])('rejects a non-advancing interval of %p ms', (dtMs) => {
    expect(findGateCrossing(...path({ dtMs }), GATE)).toBeNull();
  });

  it('rejects a stationary car sitting on the line', () => {
    // Parked on the grid with the line under the car: GPS noise alone will
    // carry the reported position back and forth across it all afternoon.
    expect(
      findGateCrossing(...path({ speedKmh: STATIONARY_SPEED_KMH }), GATE),
    ).toBeNull();
  });

  it('counts a genuinely slow crossing', () => {
    // A hairpin S/F, a kart, a car limping to the pits. Slow is not parked.
    expect(
      findGateCrossing(...path({ speedKmh: STATIONARY_SPEED_KMH + 1 }), GATE),
    ).not.toBeNull();
  });

  it('does not treat a missing speed channel as stationary', () => {
    // A null speed says nothing about whether the car is moving. Reading it as
    // "parked" would silently drop every lap of a session whose speed channel
    // dropped out — the failure mode being tested for is a *quiet* one.
    const [prev, cur] = path();

    expect(
      findGateCrossing(
        { ...prev, speedKmh: undefined },
        { ...cur, speedKmh: undefined },
        GATE,
      ),
    ).not.toBeNull();
  });

  it.each([
    ['the previous fix', 0],
    ['the current fix', 1],
  ])('rejects a hop with no GPS lock on %s', (_label, index) => {
    const fixes = path();
    fixes[index] = { ...fixes[index], lat: undefined, lon: undefined };

    expect(findGateCrossing(...fixes, GATE)).toBeNull();
  });
});
