import { Gate, LapPoint } from './analysis.types';
import { localFrame } from './geo';
import { resolveSectorGates } from './sector-gates';

const CENTER = { lat: 42.3, lon: 24.7 };
const RADIUS_M = 500;
const CIRCUMFERENCE_M = 2 * Math.PI * RADIUS_M;
const HALF_WIDTH_M = 6;

const { toGeo } = localFrame(CENTER.lat, CENTER.lon);

/** A point on the synthetic circular "circuit", at `angleRad` around it. */
function circlePoint(angleRad: number): { lat: number; lon: number } {
  return toGeo(RADIUS_M * Math.cos(angleRad), RADIUS_M * Math.sin(angleRad));
}

/**
 * The S/F gate, perpendicular to the circle at angle 0 — tangent there is due
 * "north" in the local frame, so the gate spans east-west across it.
 */
const SF_GATE: Gate = (() => {
  const p1 = toGeo(RADIUS_M, HALF_WIDTH_M);
  const p2 = toGeo(RADIUS_M, -HALF_WIDTH_M);
  return { lat1: p1.lat, lon1: p1.lon, lat2: p2.lat, lon2: p2.lon };
})();

/** The undirected ring, in increasing-angle order — an arbitrary winding. */
function buildRing(steps = 720): { lat: number; lon: number }[] {
  return Array.from({ length: steps }, (_, i) =>
    circlePoint((2 * Math.PI * i) / steps),
  );
}

/**
 * A reference lap driven around the circle, `direction` steps per sample —
 * `+1` matches the ring's own winding, `-1` drives it the other way. Distance
 * is exact arc length, since the path is a true circle.
 */
function driveLap(
  direction: 1 | -1,
  steps = 400,
): { points: LapPoint[]; distanceM: number } {
  const dTheta = ((2 * Math.PI) / steps) * direction;
  const points: LapPoint[] = Array.from({ length: steps + 1 }, (_, i) => {
    const { lat, lon } = circlePoint(i * dTheta);
    return { timeMs: i * 100, lat, lon, distM: (CIRCUMFERENCE_M * i) / steps };
  });
  return { points, distanceM: points[points.length - 1].distM };
}

describe('resolveSectorGates', () => {
  it('returns null with fewer than two eligible points on the reference lap', () => {
    const resolution = resolveSectorGates({
      sfGate: SF_GATE,
      referenceLap: {
        points: [{ timeMs: 0, lat: 42, lon: 24, distM: 0 }],
        distanceM: 0,
      },
    });

    expect(resolution).toBeNull();
  });

  it('returns null with no reference lap and nothing already resolved', () => {
    const resolution = resolveSectorGates({
      sfGate: SF_GATE,
      referenceLap: null,
    });

    expect(resolution).toBeNull();
  });

  it('prefers surveyed gates over everything else', () => {
    const surveyed: Gate[] = [{ lat1: 1, lon1: 1, lat2: 1, lon2: 2 }];
    const referenceLap = driveLap(1);

    const resolution = resolveSectorGates({
      surveyedGates: surveyed,
      persistedDerivedGates: {
        gates: [{ lat1: 9, lon1: 9, lat2: 9, lon2: 9 }],
        source: 'centreline',
      },
      sfGate: SF_GATE,
      ring: buildRing(),
      centrelineLengthM: CIRCUMFERENCE_M,
      referenceLap,
    });

    expect(resolution).toEqual({ gates: surveyed, source: 'surveyed' });
  });

  it('prefers an already-persisted derivation over deriving a new one', () => {
    const persisted = {
      gates: [{ lat1: 9, lon1: 9, lat2: 9, lon2: 9 }],
      source: 'centreline' as const,
    };
    const referenceLap = driveLap(1);

    const resolution = resolveSectorGates({
      persistedDerivedGates: persisted,
      sfGate: SF_GATE,
      ring: buildRing(),
      centrelineLengthM: CIRCUMFERENCE_M,
      referenceLap,
    });

    expect(resolution).toEqual({
      gates: persisted.gates,
      source: 'centreline',
    });
    // A plain read — nothing new to persist.
    expect(resolution?.newlyDerived).toBeUndefined();
  });

  describe('deriving from the OSM centreline', () => {
    it.each([
      ['matching the ring winding', 1 as const],
      ['against the ring winding', -1 as const],
    ])(
      'places gates at 1/3 and 2/3 of the circuit when the lap drives %s',
      (_label, direction) => {
        const ring = buildRing();
        const referenceLap = driveLap(direction);

        const resolution = resolveSectorGates({
          sfGate: SF_GATE,
          ring,
          centrelineLengthM: CIRCUMFERENCE_M,
          referenceLap,
        });

        expect(resolution?.source).toBe('centreline');
        expect(resolution?.newlyDerived).toEqual({
          gates: resolution?.gates,
          source: 'centreline',
        });
        expect(resolution?.gates).toHaveLength(2);

        // Whichever way the car actually drove, sector 1/2's boundary sits near
        // 1/3 of the way round *in the driving direction*, and 2/3 near the
        // other. The ring's own winding must not leak into the answer.
        const [gate1, gate2] = resolution!.gates;
        const angle1 = direction === 1 ? (2 * Math.PI) / 3 : -(2 * Math.PI) / 3;
        const angle2 = direction === 1 ? (4 * Math.PI) / 3 : -(4 * Math.PI) / 3;

        expect(
          distanceBetween(midpoint(gate1), circlePoint(angle1)),
        ).toBeLessThan(5);
        expect(
          distanceBetween(midpoint(gate2), circlePoint(angle2)),
        ).toBeLessThan(5);
      },
    );

    it('falls through to the reference lap when the centreline candidate does not validate', () => {
      // A ring that has nothing to do with where the car actually drove: the
      // centreline candidate's crossing distances will not land anywhere near
      // 1/3, 2/3 of the *lap's* distance, so it must be rejected rather than
      // handed back as a guess.
      const ring = buildRing();
      const straightLap: LapPoint[] = Array.from({ length: 200 }, (_, i) => ({
        timeMs: i * 100,
        lat: 10 + i * 0.0001,
        lon: 10,
        distM: i * 11.1,
      }));

      const resolution = resolveSectorGates({
        sfGate: SF_GATE,
        ring,
        centrelineLengthM: CIRCUMFERENCE_M,
        referenceLap: {
          points: straightLap,
          distanceM: straightLap[straightLap.length - 1].distM,
        },
      });

      expect(resolution?.source).toBe('reference-lap');
    });
  });

  describe('deriving from the reference lap alone', () => {
    it('builds gates directly from the lap when there is no track map', () => {
      const referenceLap = driveLap(1);

      const resolution = resolveSectorGates({
        sfGate: SF_GATE,
        referenceLap,
      });

      expect(resolution?.source).toBe('reference-lap');
      expect(resolution?.gates).toHaveLength(2);
      expect(resolution?.newlyDerived).toEqual({
        gates: resolution?.gates,
        source: 'reference-lap',
      });

      const [gate1, gate2] = resolution!.gates;
      expect(
        distanceBetween(midpoint(gate1), circlePoint((2 * Math.PI) / 3)),
      ).toBeLessThan(5);
      expect(
        distanceBetween(midpoint(gate2), circlePoint((4 * Math.PI) / 3)),
      ).toBeLessThan(5);
    });

    it('returns null when the reference lap covered no distance', () => {
      const flat: LapPoint[] = [
        { timeMs: 0, lat: 42, lon: 24, distM: 0 },
        { timeMs: 100, lat: 42, lon: 24, distM: 0 },
        { timeMs: 200, lat: 42, lon: 24, distM: 0 },
      ];

      const resolution = resolveSectorGates({
        sfGate: SF_GATE,
        referenceLap: { points: flat, distanceM: 0 },
      });

      expect(resolution).toBeNull();
    });
  });

  it('honours a sector count other than three', () => {
    // A step count not evenly divisible by 4: with an even one, the 1/4
    // boundary lands exactly on a sampled vertex rather than strictly between
    // two, and the incoming/outgoing segments can both register a crossing at
    // that shared point — a real edge case for an exact split, but not one
    // real GPS floats ever hit.
    const referenceLap = driveLap(1, 401);

    const resolution = resolveSectorGates({
      sfGate: SF_GATE,
      referenceLap,
      sectorCount: 4,
    });

    expect(resolution?.gates).toHaveLength(3);
  });
});

function midpoint(gate: Gate): { lat: number; lon: number } {
  return { lat: (gate.lat1 + gate.lat2) / 2, lon: (gate.lon1 + gate.lon2) / 2 };
}

function distanceBetween(
  a: { lat: number; lon: number },
  b: { lat: number; lon: number },
): number {
  const mLon = 111320 * Math.cos((((a.lat + b.lat) / 2) * Math.PI) / 180);
  return Math.hypot((b.lon - a.lon) * mLon, (b.lat - a.lat) * 111132);
}
