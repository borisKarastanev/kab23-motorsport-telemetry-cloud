/**
 * The Phase 4 prerequisite, as an assertion.
 *
 * The architecture doc gates Phase 4 on the mock being able to produce data that
 * can actually exercise lap segmentation. This file is what stops that quietly
 * regressing — every property here is one the segmenter, the sector splitter or
 * the braking-point detector depends on.
 *
 * Written in TypeScript because jest's `testRegex` only matches `.spec.ts`, but
 * the modules under test are plain CommonJS: `scripts/` is run directly with
 * `node`, not built. Hence `require` rather than `import`.
 */
const { localFrame } = require('./geo');
const {
  buildCircuit,
  CircuitDriver,
  KALOYANOVO,
  TARGET_LAP_M,
  rpmFor,
} = require('./circuit');

interface Point {
  x: number;
  y: number;
  lat: number;
  lon: number;
}

const TICK_MS = 100;

/** Intersect path segment P0→P1 with gate segment A→B, in local metres. */
const intersect = (
  p0: Point,
  p1: Point,
  a: { x: number; y: number },
  b: { x: number; y: number },
) => {
  const rx = p1.x - p0.x;
  const ry = p1.y - p0.y;
  const sx = b.x - a.x;
  const sy = b.y - a.y;
  const denominator = rx * sy - ry * sx;

  return {
    // Fraction along the path, and along the gate. Both in [0,1] is a crossing.
    t: ((a.x - p0.x) * sy - (a.y - p0.y) * sx) / denominator,
    u: ((a.x - p0.x) * ry - (a.y - p0.y) * rx) / denominator,
    angleDeg:
      (Math.acos(
        Math.abs(
          (rx * sx + ry * sy) / (Math.hypot(rx, ry) * Math.hypot(sx, sy)),
        ),
      ) *
        180) /
      Math.PI,
  };
};

const gateFrame = () => {
  const { gate } = KALOYANOVO;
  const midLat = (gate.lat1 + gate.lat2) / 2;
  const midLon = (gate.lon1 + gate.lon2) / 2;
  const frame = localFrame(midLat, midLon);

  return {
    midLat,
    midLon,
    frame,
    a: frame.toLocal(gate.lat1, gate.lon1),
    b: frame.toLocal(gate.lat2, gate.lon2),
  };
};

const drive = (ticks: number, seed = 20260805) => {
  const driver = new CircuitDriver({ seed });
  const samples: any[] = [];
  for (let i = 0; i < ticks; i++) {
    samples.push(driver.step(TICK_MS));
  }
  return { driver, samples };
};

describe('circuit geometry', () => {
  it('is a closed loop of the intended length', () => {
    const { lapLengthM } = buildCircuit();
    expect(lapLengthM).toBeCloseTo(TARGET_LAP_M, 0);
  });

  it('crosses the confirmed S/F gate, transversally and near its centre', () => {
    // The single property the whole prerequisite rests on. A shallow crossing,
    // or one that clips a gate endpoint, makes the segmenter drop laps
    // intermittently — the hardest failure to distinguish from a real bug.
    const { points } = buildCircuit();
    const { a, b } = gateFrame();

    const { t, u, angleDeg } = intersect(
      points[points.length - 1],
      points[1],
      a,
      b,
    );

    expect(t).toBeGreaterThan(0);
    expect(t).toBeLessThan(1);
    // Comfortably inside the gate's span, not clipping an endpoint.
    expect(u).toBeGreaterThan(0.25);
    expect(u).toBeLessThan(0.75);
    expect(angleDeg).toBeGreaterThan(80);
  });

  it('places the start/finish point on the real gate midpoint', () => {
    const { points } = buildCircuit();
    const { midLat, midLon } = gateFrame();

    expect(points[0].lat).toBeCloseTo(midLat, 6);
    expect(points[0].lon).toBeCloseTo(midLon, 6);
  });

  it('has a genuinely slow corner as well as straights', () => {
    // Sectors and braking points are only meaningful if the lap has variety. A
    // change to the waypoints or the curvature smoothing that flattens the
    // slowest corner into a sweeper should fail here, not silently downstream.
    const { kappa } = buildCircuit();

    let tightest = 0;
    let straightest = Infinity;
    for (const k of kappa) {
      tightest = Math.max(tightest, Math.abs(k));
      straightest = Math.min(straightest, Math.abs(k));
    }

    // 14.1 m: Kaloyanovo's actual tightest corner, since WAYPOINTS became a
    // real recorded lap rather than a designed shape — genuinely tighter than
    // the old hairpin's 32 m. Bounds keep a few metres of slack either side
    // rather than pinning the exact figure.
    expect(1 / tightest).toBeGreaterThan(10);
    expect(1 / tightest).toBeLessThan(20);
    expect(1 / straightest).toBeGreaterThan(1000);
  });
});

describe('speed and g channels', () => {
  it('spans a wide speed range', () => {
    const { samples } = drive(2000);
    const speeds = samples.map((s) => s.speedKmh);

    expect(Math.min(...speeds)).toBeLessThan(90);
    expect(Math.max(...speeds)).toBeGreaterThan(170);
  });

  it('produces sustained braking zones a detector can find', () => {
    const { samples } = drive(2000);

    const zones: number[] = [];
    let run = 0;
    for (const sample of samples) {
      if (sample.gLon < -0.3) {
        run++;
      } else {
        if (run) zones.push(run);
        run = 0;
      }
    }

    // Several distinct zones, at least one of them held for a good half-second.
    expect(zones.length).toBeGreaterThanOrEqual(8);
    expect(Math.max(...zones)).toBeGreaterThanOrEqual(5);
  });

  it('never spikes longitudinal g at the start/finish line', () => {
    // Regression guard, and the threshold is chosen to actually bite. Swapping
    // the speed profile at the line puts a ~1.5% speed step into one 100 ms
    // tick: measured at 0.95 g swapping outright, and 1.28 g anchoring the new
    // profile to the old one's index 0. Anchored correctly it is 0.35 g — the
    // traction limit, i.e. indistinguishable from ordinary corner exit.
    //
    // Several seeds, because the size of the step depends on the pace draw and
    // a single seed can miss it entirely.
    for (const seed of [1, 2, 7, 42, 4242, 20260805, 99999]) {
      const { samples } = drive(3000, seed);

      let previousLap = samples[0].lap;
      for (const sample of samples) {
        if (sample.lap === previousLap) continue;
        previousLap = sample.lap;
        expect(Math.abs(sample.gLon)).toBeLessThan(0.6);
      }
    }
  });

  it('keeps longitudinal g inside the car’s grip everywhere', () => {
    const { samples } = drive(3000);

    for (const sample of samples) {
      // Braking is the harder limit (1.1 g, plus per-lap jitter and the Euler
      // step's overshoot); traction is far below it.
      expect(sample.gLon).toBeGreaterThan(-1.4);
      expect(sample.gLon).toBeLessThan(0.7);
    }
  });

  it('agrees with the geometry on lateral g', () => {
    // gLat is v²κ/g, so peak lateral load must land near the grip limit the
    // profile was solved for rather than being an independent invention.
    const { samples } = drive(2000);
    const peak = Math.max(...samples.map((s) => Math.abs(s.gLat)));

    expect(peak).toBeGreaterThan(1.0);
    expect(peak).toBeLessThan(1.5);
  });
});

describe('lap timing', () => {
  it('completes several timed laps with varying times', () => {
    // The prerequisite's exit criterion: the spread has to be real, which is
    // what gives lap-vs-lap comparison something to draw.
    const { driver } = drive(4000);
    const laps: number[] = driver.completedLapMs;

    expect(laps.length).toBeGreaterThanOrEqual(3);
    expect(new Set(laps).size).toBeGreaterThanOrEqual(3);
    expect(Math.max(...laps) - Math.min(...laps)).toBeGreaterThanOrEqual(300);
  });

  it('times laps from the crossing, not from the tick that noticed it', () => {
    // These numbers exist to be checked against the segmenter's, which
    // interpolates the crossing sub-sample. A lap clock zeroed at the tick that
    // detected the overshoot instead of at the crossing carries up to a tick
    // from each end — ±100 ms at 10 Hz — and a disagreement smaller than that
    // then means nothing, which is most of the disagreements worth catching.
    const { driver } = drive(4000);
    const laps: number[] = driver.completedLapMs;

    expect(laps.length).toBeGreaterThanOrEqual(3);
    // Quantised to the tick, *every* one of these would be a multiple of 100.
    expect(laps.filter((ms) => ms % TICK_MS === 0).length).toBeLessThanOrEqual(
      1,
    );
  });

  it('counts the out-lap as lap 0, as the dash does', () => {
    // Matching `RaceBoxModel::m_lapNumber`, which stays 0 until the first
    // accepted crossing. Keeping the convention is what makes the device's own
    // lap number directly comparable with the one the cloud derives.
    const { samples } = drive(50);
    expect(samples[0].lap).toBe(0);
  });

  it('increments the lap counter at the start/finish line', () => {
    const { samples } = drive(4000);
    const { a, b, frame } = gateFrame();
    const midX = (a.x + b.x) / 2;
    const midY = (a.y + b.y) / 2;

    let previousLap = samples[0].lap;
    let increments = 0;

    for (const sample of samples) {
      if (sample.lap === previousLap) continue;
      previousLap = sample.lap;
      increments++;

      const local = frame.toLocal(sample.lat, sample.lon);
      expect(Math.hypot(local.x - midX, local.y - midY)).toBeLessThan(20);
    }

    expect(increments).toBeGreaterThanOrEqual(3);
  });
});

describe('determinism', () => {
  it('reproduces the same laps for the same seed', () => {
    expect(drive(2500, 4242).driver.completedLapMs).toEqual(
      drive(2500, 4242).driver.completedLapMs,
    );
  });

  it('produces different laps for a different seed', () => {
    expect(drive(2500, 1).driver.completedLapMs).not.toEqual(
      drive(2500, 2).driver.completedLapMs,
    );
  });
});

describe('rpmFor', () => {
  it('shifts up rather than exceeding the redline', () => {
    for (let kmh = 0; kmh <= 200; kmh += 5) {
      expect(rpmFor(kmh)).toBeLessThanOrEqual(7000);
      expect(rpmFor(kmh)).toBeGreaterThanOrEqual(850);
    }
  });

  it('idles rather than returning an implausibly low rpm at a standstill', () => {
    expect(rpmFor(0)).toBe(850);
  });
});
