import {
  METERS_PER_DEG_LAT,
  boundsOf,
  localProjection,
  isUsableDistance,
  pointAtDistance,
  projectCircuit,
  smoothAlongDistance,
  smoothingSigmaM,
} from './geo-projection';

describe('localProjection', () => {
  it('maps the origin to (0, 0)', () => {
    const project = localProjection({ lat: 42.34, lon: 24.73 });
    const p = project({ lat: 42.34, lon: 24.73 });
    // toBeCloseTo, not toEqual: y is -0, which toEqual distinguishes from 0.
    expect(p.x).toBeCloseTo(0, 12);
    expect(p.y).toBeCloseTo(0, 12);
  });

  it('puts north up (negative y) and east right, in metres', () => {
    const project = localProjection({ lat: 0, lon: 0 });
    const p = project({ lat: 0.001, lon: 0.001 });
    expect(p.x).toBeCloseTo(0.001 * METERS_PER_DEG_LAT, 6);
    expect(p.y).toBeCloseTo(-0.001 * METERS_PER_DEG_LAT, 6);
  });

  it('shrinks longitude by cos(latitude)', () => {
    const project = localProjection({ lat: 60, lon: 10 });
    // cos(60°) = 0.5
    expect(project({ lat: 60, lon: 10.001 }).x).toBeCloseTo(0.0005 * METERS_PER_DEG_LAT, 6);
  });

  it('keeps nearby points distinct after a float32 round-trip, unlike raw degrees', () => {
    // The original bug: two fixes 10 cm apart at 42°N collapse to the same
    // float32 in degrees (≈0.42 m resolution), but not in local metres.
    const a = { lat: 42.3409804, lon: 24.73 };
    const b = { lat: a.lat + 0.1 / METERS_PER_DEG_LAT, lon: 24.73 };
    expect(Math.fround(-a.lat)).toBe(Math.fround(-b.lat));

    const project = localProjection({ lat: 42.34, lon: 24.73 });
    expect(Math.fround(project(a).y)).not.toBe(Math.fround(project(b).y));
  });
});

describe('projectCircuit', () => {
  const ring = [
    [24.73, 42.34],
    [24.731, 42.34],
    [24.731, 42.341],
    [24.73, 42.34],
  ];

  it('anchors on the first coordinate and returns the ring in local metres', () => {
    const { origin, points, bounds } = projectCircuit(ring);
    expect(origin).toEqual({ lat: 42.34, lon: 24.73 });
    expect(points).toHaveLength(4);
    expect(points[0].x).toBeCloseTo(0, 9);
    expect(bounds.minX).toBeCloseTo(0, 9);
    expect(bounds.maxX).toBeGreaterThan(70);
    expect(bounds.minY).toBeLessThan(-100);
  });

  it('returns a projection that agrees with the ring it projected', () => {
    const { project, points } = projectCircuit(ring);
    expect(project({ lat: 42.341, lon: 24.731 })).toEqual(points[2]);
  });
});

describe('boundsOf', () => {
  it('spans every list', () => {
    expect(
      boundsOf([
        [{ x: 1, y: 5 }],
        [
          { x: -2, y: 3 },
          { x: 4, y: -1 },
        ],
      ]),
    ).toEqual({ minX: -2, maxX: 4, minY: -1, maxY: 5 });
  });

  it('grows from a seed without mutating it', () => {
    const seed = { minX: 0, maxX: 1, minY: 0, maxY: 1 };
    expect(boundsOf([[{ x: 5, y: -5 }]], seed)).toEqual({ minX: 0, maxX: 5, minY: -5, maxY: 1 });
    expect(seed).toEqual({ minX: 0, maxX: 1, minY: 0, maxY: 1 });
  });
});

describe('smoothingSigmaM', () => {
  it('floors at 3 m for densely sampled or tiny traces', () => {
    expect(smoothingSigmaM([0])).toBe(3);
    expect(smoothingSigmaM([0, 1, 2, 3])).toBe(3);
  });

  it('scales with the median spacing on a sparse trace', () => {
    // Median step 6 m (one outlier ignored) → 1.5 × 6 = 9 m.
    expect(smoothingSigmaM([0, 6, 12, 18, 100])).toBe(9);
  });
});

describe('smoothAlongDistance', () => {
  const line = (n: number, step: number) => ({
    points: Array.from({ length: n }, (_, i) => ({ x: i * step, y: 0 })),
    dist: Array.from({ length: n }, (_, i) => i * step),
  });

  it('returns short traces and a non-positive sigma unchanged', () => {
    const two = [
      { x: 0, y: 0 },
      { x: 1, y: 1 },
    ];
    expect(smoothAlongDistance(two, [0, 1], 3)).toBe(two);

    const { points, dist } = line(5, 1);
    expect(smoothAlongDistance(points, dist, 0)).toBe(points);
  });

  it('leaves a straight, evenly sampled line where it was', () => {
    const { points, dist } = line(20, 2);
    const out = smoothAlongDistance(points, dist, 3);
    // Interior points are symmetric about themselves.
    for (let i = 5; i < 15; i++) {
      expect(out[i].x).toBeCloseTo(points[i].x, 9);
      expect(out[i].y).toBeCloseTo(0, 9);
    }
  });

  it('averages out alternating jitter', () => {
    const { points, dist } = line(40, 2);
    const jittered = points.map((p, i) => ({ x: p.x, y: i % 2 ? 0.7 : -0.7 }));
    const out = smoothAlongDistance(jittered, dist, 3);
    for (let i = 10; i < 30; i++) {
      expect(Math.abs(out[i].y)).toBeLessThan(0.05);
    }
  });

  it('pins the first and last points so a lap still starts and ends on its gate', () => {
    const { points, dist } = line(20, 2);
    const out = smoothAlongDistance(points, dist, 3);
    expect(out[0]).toBe(points[0]);
    expect(out[19]).toBe(points[19]);
  });

  it('returns the raw points when a distance is missing, instead of poisoning every point', () => {
    const { points, dist } = line(10, 2);
    dist[4] = NaN;
    expect(smoothAlongDistance(points, dist, 3)).toBe(points);
  });

  it('copes with repeated distances (an optimal lap seam, a stopped car)', () => {
    const { points } = line(8, 1);
    const out = smoothAlongDistance(points, [0, 1, 2, 2, 2, 3, 4, 5], 3);
    expect(out).toHaveLength(8);
    expect(out.every((p) => Number.isFinite(p.x) && Number.isFinite(p.y))).toBe(true);
  });

  it('weights by distance, not sample index — an uneven gap does not drag the line', () => {
    // A dense cluster near x=0 must not pull a point 50 m away.
    const points = [
      { x: 0, y: 5 },
      { x: 0.1, y: 5 },
      { x: 0.2, y: 5 },
      { x: 50, y: 0 },
      { x: 52, y: 0 },
    ];
    const dist = [0, 0.1, 0.2, 50, 52];
    const out = smoothAlongDistance(points, dist, 3);
    expect(out[3].y).toBeCloseTo(0, 9);
    expect(out[0].y).toBeCloseTo(5, 9);
  });
});

describe('isUsableDistance', () => {
  it('accepts finite distances and rejects NaN, null-coerced and infinite ones', () => {
    expect(isUsableDistance([0, 1, 2])).toBe(true);
    expect(isUsableDistance([])).toBe(true);
    expect(isUsableDistance([0, NaN])).toBe(false);
    expect(isUsableDistance([0, Infinity])).toBe(false);
  });
});

describe('pointAtDistance', () => {
  const points = [
    { x: 0, y: 0 },
    { x: 10, y: 0 },
    { x: 10, y: 10 },
  ];
  const dist = [0, 10, 20];

  it('interpolates between the samples either side', () => {
    expect(pointAtDistance(points, dist, 5)).toEqual({ x: 5, y: 0 });
    expect(pointAtDistance(points, dist, 15)).toEqual({ x: 10, y: 5 });
  });

  it('returns a sample exactly when the distance lands on one', () => {
    expect(pointAtDistance(points, dist, 10)).toEqual({ x: 10, y: 0 });
  });

  it('clamps before the start and after the end', () => {
    expect(pointAtDistance(points, dist, -3)).toBe(points[0]);
    expect(pointAtDistance(points, dist, 99)).toBe(points[2]);
  });

  it('copes with two samples at the same distance', () => {
    expect(
      pointAtDistance(
        [
          { x: 0, y: 0 },
          { x: 1, y: 1 },
          { x: 2, y: 2 },
        ],
        [0, 5, 5],
        5,
      ),
    ).toEqual({ x: 2, y: 2 });
  });
});
