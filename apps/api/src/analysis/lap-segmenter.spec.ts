import { AnalysisSample, Gate } from './analysis.types';
import { MAX_FIX_GAP_MS, MIN_LAP_MS } from './gate-crossing';
import { localFrame } from './geo';
import { segmentLaps } from './lap-segmenter';

/**
 * The segmenter is exercised against the **mock publisher's own circuit
 * generator**, not against a hand-drawn trace.
 *
 * `require` rather than `import` on purpose: `scripts/` is plain CommonJS run
 * directly by `node`, and the root tsconfig has no `allowJs`, so an `import`
 * would fail to type-check. This is the same boundary `jest.config`'s
 * `transform: ^.+\.ts$` narrowing exists for.
 *
 * The value of driving the real generator is that this becomes a test of two
 * independent implementations agreeing: the generator counts laps by distance
 * travelled around a closed path, the segmenter counts them by intersecting a
 * gate. Nothing is shared between the two but the geometry, so a lap-time match
 * is real evidence rather than a tautology.
 */
// Destructured on the next line, not here: prettier wraps a long destructuring
// pattern onto its own line, which would push the `require` out from under the
// disable comment and fail lint.
// eslint-disable-next-line @typescript-eslint/no-var-requires
const circuit = require('../../../../scripts/lib/circuit');
const { CircuitDriver, KALOYANOVO } = circuit;

const GATE: Gate = KALOYANOVO.gate;
const SESSION_START = Date.UTC(2026, 7, 5, 10, 0, 0);

interface MockDrive {
  samples: AnalysisSample[];
  /** The lap number the device itself stamped on each sample. */
  deviceLap: number[];
  /** Lap times as the generator measured them, in order. */
  deviceLapMs: number[];
  lapLengthM: number;
}

/** Drive the synthesized Kaloyanovo circuit at 10 Hz, as the mock does. */
function driveMock({
  seconds = 260,
  dtMs = 100,
  seed = 20260805,
} = {}): MockDrive {
  const driver = new CircuitDriver({ seed });
  const samples: AnalysisSample[] = [];
  const deviceLap: number[] = [];

  for (let i = 1; i <= (seconds * 1000) / dtMs; i++) {
    const frame = driver.step(dtMs);

    samples.push({
      time: new Date(SESSION_START + i * dtMs),
      lat: frame.lat,
      lon: frame.lon,
      speedKmh: frame.speedKmh,
      rpm: frame.rpm,
      gLat: frame.gLat,
      gLon: frame.gLon,
    });
    deviceLap.push(frame.lap);
  }

  return {
    samples,
    deviceLap,
    deviceLapMs: driver.completedLapMs,
    lapLengthM: driver.lapLengthM,
  };
}

describe('LapSegmenter, against the mock circuit', () => {
  const drive = driveMock();
  const laps = segmentLaps(drive.samples, GATE);

  it('meets the prerequisite: at least three laps, with distinct times', () => {
    // The §1.3 exit criterion, asserted here against the consumer rather than
    // against the generator, so neither half can regress silently.
    expect(laps.length).toBeGreaterThanOrEqual(3);
    expect(new Set(laps.map((lap) => lap.lapMs)).size).toBe(laps.length);
  });

  it('agrees with the generator on every lap time', () => {
    // Within one 10 Hz tick. The two disagree only by the sub-sample
    // interpolation and the GPS noise the generator adds — if they disagreed by
    // more, one of them would be wrong about where the line is.
    expect(laps).not.toHaveLength(0);

    laps.forEach((lap, i) => {
      expect(Math.abs(lap.lapMs - drive.deviceLapMs[i])).toBeLessThanOrEqual(
        100,
      );
    });
  });

  it('numbers laps as the device does, starting after the out-lap', () => {
    // The run from the first sample to the first sight of the line has no lap
    // time, so it is not lap 1 — and the device agrees, stamping those samples
    // `lap 0`.
    expect(laps.map((lap) => lap.lapNumber)).toEqual(laps.map((_, i) => i + 1));
    expect(drive.deviceLap[0]).toBe(0);
    expect(laps[0].startedAt.getTime()).toBeGreaterThan(SESSION_START);
  });

  it('does not emit the partial lap the session ended mid-way through', () => {
    const last = laps[laps.length - 1];
    const sessionEnd = drive.samples[drive.samples.length - 1].time.getTime();

    // Samples kept coming after the final crossing; they are an in-lap, not a
    // lap, and a lap table that showed them would show a fast "best lap".
    expect(sessionEnd - last.endedAt.getTime()).toBeGreaterThan(1000);
  });

  it('measures each lap at the circuit length', () => {
    for (const lap of laps) {
      // Half a per cent. This is tight on purpose: distance is integrated from
      // the speed channel rather than differenced from the fixes, and the
      // margin has to be narrow enough to fail if that ever reverts —
      // differencing comes out a consistent 5 % long here, because it sums the
      // GPS noise along with the travel.
      expect(lap.distanceM).toBeGreaterThan(drive.lapLengthM * 0.995);
      expect(lap.distanceM).toBeLessThan(drive.lapLengthM * 1.005);
    }
  });

  it('measures the same distance every lap', () => {
    // The property `compare` depends on: two laps of the same circuit must
    // share a distance axis. Any lap-to-lap disagreement here shows up there as
    // delta the driver never lost, growing towards the end of the lap.
    const distances = laps.map((lap) => lap.distanceM);
    const spread = Math.max(...distances) - Math.min(...distances);

    expect(spread / Math.min(...distances)).toBeLessThan(0.005);
  });

  it('reports speeds consistent with the circuit', () => {
    for (const lap of laps) {
      expect(lap.minSpeedKmh).toBeGreaterThan(40);
      expect(lap.maxSpeedKmh).toBeLessThan(220);
      expect(lap.maxSpeedKmh).toBeGreaterThan(lap.minSpeedKmh);
    }
  });

  it('splits every lap into sectors that sum to the lap time', () => {
    for (const lap of laps) {
      expect(lap.sectorMs).toHaveLength(3);
      const sum = lap.sectorMs.reduce((a, b) => a + b, 0);
      // Rounding to whole milliseconds is the only permitted discrepancy.
      expect(Math.abs(sum - lap.lapMs)).toBeLessThanOrEqual(2);
    }
  });

  it("finds the circuit's braking zones", () => {
    for (const lap of laps) {
      // The synthesized circuit is eight *waypoints* but not eight corners:
      // resampled, its radius swings between 40 m and 150 m every 20–40 m
      // through the second half, so a car at the traction limit brakes far
      // more often than a corner count suggests. The bound is wide because it
      // is a sanity check on the order of magnitude; the assertion that
      // actually constrains the detector is the stability one below.
      expect(lap.brakingPoints.length).toBeGreaterThanOrEqual(10);
      expect(lap.brakingPoints.length).toBeLessThanOrEqual(30);

      for (const point of lap.brakingPoints) {
        expect(point.peakDecelG).toBeGreaterThanOrEqual(0.3);
        expect(point.peakDecelG).toBeLessThan(2);
        expect(point.entrySpeedKmh).toBeGreaterThan(0);
        expect(point.distM).toBeGreaterThanOrEqual(0);
        expect(point.distM).toBeLessThanOrEqual(lap.distanceM);
      }
    }
  });

  it('places braking points in the same zones lap after lap', () => {
    // The whole reason the mock varies braking points a few per cent lap to
    // lap is so the lap-compare UI has something real to draw. Varying and
    // wandering are different things: zone n of one lap must still be zone n
    // of the next, or the markers are noise wearing a marker's clothes.
    //
    // This is the assertion the merge threshold exists for. Without it the
    // detector splits one braking event into three markers 6 m apart wherever
    // the driver eases for a tenth of a second, and the count then swings lap
    // to lap as pace moves a fragment across the threshold.
    const [first, ...rest] = laps;

    for (const lap of rest) {
      expect(lap.brakingPoints).toHaveLength(first.brakingPoints.length);

      lap.brakingPoints.forEach((point, i) => {
        expect(
          Math.abs(point.distM - first.brakingPoints[i].distM),
        ).toBeLessThan(30);
      });
    }
  });

  it('does not fabricate a lap across a gap in the samples', () => {
    // Punch out the fixes either side of the second crossing — an LTE stall,
    // or a device that rebooted. Bridging that hop would interpolate a
    // straight line across it, and near the line that is an invented crossing.
    const crossingIndex = drive.deviceLap.findIndex((lap) => lap === 2);
    const holed = drive.samples.filter(
      (_, i) => i < crossingIndex - 5 || i > crossingIndex + 5,
    );

    const gapMs =
      holed[crossingIndex - 5].time.getTime() -
      holed[crossingIndex - 6].time.getTime();
    expect(gapMs).toBeGreaterThan(MAX_FIX_GAP_MS);

    const derived = segmentLaps(holed, GATE);
    expect(derived).toHaveLength(laps.length - 1);
    // The two laps either side of the hole became one long one rather than
    // being dropped — no lap has vanished, and none has a phantom time.
    expect(Math.max(...derived.map((lap) => lap.lapMs))).toBeGreaterThan(
      laps[0].lapMs * 1.8,
    );
  });

  it('ignores samples with no GPS lock without losing the lap', () => {
    // A fix arrives with the position channels null — a lost lock in a tunnel
    // of trees. It contributes nothing, but it must not end the lap either.
    const blinded = drive.samples.map((sample, i) =>
      i % 40 === 7 ? { ...sample, lat: undefined, lon: undefined } : sample,
    );

    const derived = segmentLaps(blinded, GATE);
    expect(derived).toHaveLength(laps.length);
    derived.forEach((lap, i) => {
      expect(Math.abs(lap.lapMs - laps[i].lapMs)).toBeLessThanOrEqual(200);
    });
  });
});

describe('LapSegmenter, on hand-built traces', () => {
  const frame = localFrame(
    (GATE.lat1 + GATE.lat2) / 2,
    (GATE.lon1 + GATE.lon2) / 2,
  );
  const A = frame.toLocal(GATE.lat1, GATE.lon1);
  const B = frame.toLocal(GATE.lat2, GATE.lon2);
  const along = { x: B.x - A.x, y: B.y - A.y };
  const len = Math.hypot(along.x, along.y);
  const across = { x: -along.y / len, y: along.x / len };

  /**
   * A straight run through the gate midpoint, `count` fixes at 100 ms, centred
   * on `atMs`. `reverse` drives it the other way.
   */
  function pass(atMs: number, reverse = false, count = 11): AnalysisSample[] {
    const mid = { x: A.x + along.x / 2, y: A.y + along.y / 2 };
    const sign = reverse ? -1 : 1;

    return Array.from({ length: count }, (_, i) => {
      const offsetM = (i - (count - 1) / 2) * 5 * sign;
      const { lat, lon } = frame.toGeo(
        mid.x + across.x * offsetM,
        mid.y + across.y * offsetM,
      );

      return {
        time: new Date(SESSION_START + atMs + (i - (count - 1) / 2) * 100),
        lat,
        lon,
        speedKmh: 180,
      };
    });
  }

  it('debounces a second crossing inside the minimum lap time', () => {
    // GPS jitter straddling the line on consecutive fixes, or a car that
    // stopped just past it and rolled back. Not a 1.5 s lap.
    const samples = [
      ...pass(0),
      ...pass(MIN_LAP_MS / 2),
      ...pass(MIN_LAP_MS * 3),
    ];

    const laps = segmentLaps(samples, GATE);
    expect(laps).toHaveLength(1);
    expect(laps[0].lapMs).toBeGreaterThanOrEqual(MIN_LAP_MS);
  });

  it('ignores a pass the wrong way down the line', () => {
    // The pit lane rejoins on the other side of the line at plenty of
    // circuits. Crossing it backwards is not a lap, and — the part that
    // matters — must not restart the timer either.
    const samples = [...pass(0), ...pass(10_000, true), ...pass(20_000)];

    const laps = segmentLaps(samples, GATE);
    expect(laps).toHaveLength(1);
    expect(laps[0].lapMs).toBeCloseTo(20_000, -2);
  });

  it('latches the racing direction on the arming crossing', () => {
    // Same three passes, first one reversed: whichever way the car first
    // crosses is now "forwards", and the other two are the wrong way.
    const samples = [...pass(0, true), ...pass(10_000), ...pass(20_000)];

    expect(segmentLaps(samples, GATE)).toHaveLength(0);
  });

  it('derives nothing from a session that never reaches the line', () => {
    const samples = pass(0).map((sample) => ({
      ...sample,
      lat: sample.lat + 0.01,
    }));

    expect(segmentLaps(samples, GATE)).toHaveLength(0);
  });
});
