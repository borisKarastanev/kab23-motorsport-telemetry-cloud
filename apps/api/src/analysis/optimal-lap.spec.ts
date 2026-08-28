import { LapTracePointDto } from './dto/lap-trace.dto';
import { Lap } from './entities/lap.entity';
import { buildOptimalLap, stitchOptimalTrace } from './optimal-lap';

function lap(overrides: Partial<Lap>): Lap {
  return {
    lapNumber: 1,
    lapMs: 90_000,
    distanceM: 3000,
    sectorMs: [30_000, 30_000, 30_000],
    brakingPoints: [],
    isBest: false,
    ...overrides,
  } as Lap;
}

describe('buildOptimalLap', () => {
  it('returns null under two eligible laps', () => {
    expect(buildOptimalLap([lap({ lapNumber: 1 })])).toBeNull();
    expect(buildOptimalLap([])).toBeNull();
  });

  it('combines the best sectors and reports their source laps', () => {
    const laps = [
      lap({ lapNumber: 1, sectorMs: [28_000, 31_000, 27_000] }),
      lap({ lapNumber: 2, sectorMs: [29_000, 30_000, 26_000] }),
    ];

    const plan = buildOptimalLap(laps);

    expect(plan).not.toBeNull();
    expect(plan!.sectors).toEqual([
      { sector: 0, lapNumber: 1, sectorMs: 28_000 },
      { sector: 1, lapNumber: 2, sectorMs: 30_000 },
      { sector: 2, lapNumber: 2, sectorMs: 26_000 },
    ]);
    expect(plan!.lapMs).toBe(84_000);
    expect(plan!.matchesLapNumber).toBeNull();
    expect(plan!.seams).toEqual([]);
  });

  it("rebases each contributing lap's braking points onto the stitched axis", () => {
    const laps = [
      lap({
        lapNumber: 1,
        distanceM: 3000,
        sectorMs: [28_000, 31_000, 27_000],
        brakingPoints: [
          { distM: 500, lat: 1, lon: 1, entrySpeedKmh: 150, peakDecelG: 1 }, // in S1
          { distM: 1500, lat: 1, lon: 1, entrySpeedKmh: 150, peakDecelG: 1 }, // in S2, not S1's lap
        ],
      }),
      lap({
        lapNumber: 2,
        distanceM: 3000,
        sectorMs: [29_000, 30_000, 26_000],
        brakingPoints: [
          { distM: 1500, lat: 2, lon: 2, entrySpeedKmh: 140, peakDecelG: 1.1 }, // in S2
          { distM: 2500, lat: 2, lon: 2, entrySpeedKmh: 140, peakDecelG: 1.1 }, // in S3
        ],
      }),
    ];

    const plan = buildOptimalLap(laps)!;

    // S1 comes from lap 1 (its own [0, 1000) range); S2 and S3 come from lap 2.
    // Each contributing lap is split into thirds of its own 3000 m, i.e. 1000 m
    // sectors, so a braking point already at the sector's own local position
    // rebases by adding the stitched offset before that sector started.
    expect(plan.brakingPoints).toEqual([
      { distM: 500, lat: 1, lon: 1, entrySpeedKmh: 150, peakDecelG: 1 }, // S1, offset 0
      { distM: 1500, lat: 2, lon: 2, entrySpeedKmh: 140, peakDecelG: 1.1 }, // S2, offset 1000
      { distM: 2500, lat: 2, lon: 2, entrySpeedKmh: 140, peakDecelG: 1.1 }, // S3, offset 2000
    ]);
  });

  it('says the optimal matches a lap when every sector came from it', () => {
    const laps = [
      lap({ lapNumber: 1, sectorMs: [28_000, 29_000, 27_000] }),
      lap({ lapNumber: 2, sectorMs: [30_000, 31_000, 30_000] }),
    ];

    const plan = buildOptimalLap(laps)!;
    expect(plan.matchesLapNumber).toBe(1);
  });
});

/**
 * A straight-line, constant-speed trace over `distanceM` in `lapMs`.
 *
 * The elapsed axis is the lap's *own* — a real trace's last `elapsedMs` is the
 * lap's `lapMs`, i.e. the sum of its `sectorMs`, and the stitch now reads its
 * boundaries off exactly that relationship. A fixture whose trace ran for a
 * different duration than its splits claim would put the boundaries somewhere
 * neither the old code nor the new one would ever land.
 */
function straightTrace({
  distanceM,
  lapMs,
  count = 101,
  latOffset = 0,
}: {
  distanceM: number;
  lapMs: number;
  count?: number;
  latOffset?: number;
}): LapTracePointDto[] {
  return Array.from({ length: count }, (_, i) => {
    const distM = (distanceM * i) / (count - 1);
    return {
      distM,
      elapsedMs: (distM / distanceM) * lapMs,
      lat: 42 + distM / 1_000_000 + latOffset,
      lon: 24,
      speedKmh: 360,
      rpm: 8000,
      coolantC: 90,
      oilC: 100,
      gLat: 0,
      gLon: 0,
    };
  });
}

/** Each lap paired with a trace of its own distance and its own lap time. */
function contributing(
  laps: Lap[],
  overrides: { count?: number; latOffset?: number } = {},
) {
  return new Map(
    laps.map((l) => [
      l.lapNumber,
      {
        sectorMs: l.sectorMs,
        points: straightTrace({
          distanceM: l.distanceM,
          lapMs: l.sectorMs.reduce((a, b) => a + b, 0),
          ...overrides,
        }),
      },
    ]),
  );
}

describe('stitchOptimalTrace', () => {
  it('preserves the total elapsed time exactly', () => {
    const laps = [
      lap({ lapNumber: 1, distanceM: 1000, sectorMs: [3000, 3200, 3400] }),
      lap({ lapNumber: 2, distanceM: 1000, sectorMs: [3100, 3000, 3300] }),
    ];
    const plan = buildOptimalLap(laps)!;

    const points = stitchOptimalTrace(plan, contributing(laps), 1000);

    expect(points[0].elapsedMs).toBe(0);
    expect(points[points.length - 1].elapsedMs).toBe(plan.lapMs);
  });

  it('produces a monotonic distance and elapsed-time axis', () => {
    const laps = [
      lap({ lapNumber: 1, distanceM: 1000, sectorMs: [3000, 3200, 3400] }),
      lap({ lapNumber: 2, distanceM: 1000, sectorMs: [3100, 3000, 3300] }),
    ];
    const plan = buildOptimalLap(laps)!;

    const points = stitchOptimalTrace(plan, contributing(laps), 1000);

    for (let i = 1; i < points.length; i++) {
      expect(points[i].distM).toBeGreaterThanOrEqual(points[i - 1].distM);
      expect(points[i].elapsedMs).toBeGreaterThanOrEqual(
        points[i - 1].elapsedMs,
      );
    }
  });

  it("cuts each sector where that lap's own splits say it ended", () => {
    // Deliberately lopsided splits: S1 is a fifth of the lap and S2 takes it to
    // three fifths. On a constant-speed trace those are 200 m and 600 m — where
    // the gates that produced these times are. Cutting at equal fractions of
    // the distance instead splices at 333 m and 667 m, which is the failure
    // this covers: `sector-gates.ts` accepts a gate up to 0.4 of a sector off
    // its nominal fraction, so a valid gate really can sit here.
    const laps = [
      lap({ lapNumber: 1, distanceM: 1000, sectorMs: [2000, 4000, 4000] }),
      lap({ lapNumber: 2, distanceM: 1000, sectorMs: [2500, 4500, 4500] }),
    ];
    const plan = buildOptimalLap(laps)!;

    const points = stitchOptimalTrace(plan, contributing(laps), 1000);

    // Every sector came from lap 1, so the joins land on its own boundaries.
    expect(plan.seams.map((seam) => seam.distM)).toEqual([200, 600]);
    // And the boundary instants line up with the splits, not with a third of
    // the lap: at 2 s the car is 200 m in, not 333 m.
    const atFirstBoundary = points.find((p) => p.elapsedMs === 2000)!;
    expect(atFirstBoundary.distM).toBeCloseTo(200, 1);
    expect(points[points.length - 1].distM).toBeCloseTo(1000, 1);
  });

  it('records a seam at every interior join, none at the very start', () => {
    // Alternating winners (lap 1, lap 2, lap 1) so both interior joins are
    // genuinely cross-lap — a join between two sectors of the *same* lap
    // would correctly show a zero gap, which is not what this is testing.
    const laps = [
      lap({ lapNumber: 1, distanceM: 1000, sectorMs: [3000, 3200, 3000] }),
      lap({ lapNumber: 2, distanceM: 1000, sectorMs: [3200, 3000, 3200] }),
    ];
    const plan = buildOptimalLap(laps)!;

    // Lap 2's trace offset a few metres sideways, so the two laps' geometry at
    // a shared boundary genuinely differs — the seam this is measuring.
    const contributingByLap = new Map([
      ...contributing([laps[0]]),
      ...contributing([laps[1]], { latOffset: 0.0001 }),
    ]);

    stitchOptimalTrace(plan, contributingByLap, 1000);

    // Two interior joins for a three-sector lap (S1→S2, S2→S3).
    expect(plan.seams).toHaveLength(2);
    for (const seam of plan.seams) {
      expect(seam.gapM).toBeGreaterThan(0);
    }
  });

  it('interpolates a boundary point rather than snapping to a raw sample', () => {
    const laps = [
      lap({ lapNumber: 1, distanceM: 999, sectorMs: [3000, 3200, 3400] }),
      lap({ lapNumber: 2, distanceM: 999, sectorMs: [3100, 3000, 3300] }),
    ];
    const plan = buildOptimalLap(laps)!;

    // Coarse traces: raw samples only every 333 m, and neither boundary falls
    // on one — S1 ends 312.2 m into lap 1 (3 000 ms of its 9 600), and S2 ends
    // 318.8 m further on, cut out of lap 2.
    const points = stitchOptimalTrace(
      plan,
      contributing(laps, { count: 4 }),
      1000,
    );

    expect(plan.seams[0].distM).toBeCloseTo(312.2, 1);
    expect(plan.seams[1].distM).toBeCloseTo(631.0, 1);
    // And the stitch actually put a point on each of them, rather than letting
    // the nearest raw sample stand in for the boundary.
    for (const seam of plan.seams) {
      expect(points.some((p) => p.distM === seam.distM)).toBe(true);
      expect(seam.distM % 333).not.toBe(0);
    }
  });

  it('returns nothing at all when a contributing lap has no trace', () => {
    // Not "skips that sector": dropping a third of the geometry while its time
    // still counted produced a trace two thirds long whose last point claimed
    // the full lap time. There is no partial optimal lap — the caller 404s.
    const laps = [
      lap({ lapNumber: 1, distanceM: 1000, sectorMs: [3000, 3200, 3400] }),
      lap({ lapNumber: 2, distanceM: 1000, sectorMs: [3100, 3000, 3300] }),
    ];
    const plan = buildOptimalLap(laps)!;
    const contributingByLap = contributing([laps[0]]); // lap 2 missing

    expect(stitchOptimalTrace(plan, contributingByLap, 1000)).toEqual([]);
  });

  it('falls back to equal fractions for a lap with no usable splits', () => {
    // A guard rather than a path — `pickBestSectors` only picks laps with a
    // complete split set — but a mis-drawn line beats a crash.
    const laps = [
      lap({ lapNumber: 1, distanceM: 1000, sectorMs: [3000, 3000, 3000] }),
      lap({ lapNumber: 2, distanceM: 1000, sectorMs: [3100, 3100, 3100] }),
    ];
    const plan = buildOptimalLap(laps)!;
    const contributingByLap = new Map(
      [...contributing(laps)].map(([lapNumber, entry]) => [
        lapNumber,
        { ...entry, sectorMs: [] },
      ]),
    );

    const points = stitchOptimalTrace(plan, contributingByLap, 1000);

    expect(plan.seams.map((seam) => seam.distM)).toEqual([333.3, 666.7]);
    expect(points[points.length - 1].elapsedMs).toBe(plan.lapMs);
  });
});
