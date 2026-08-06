import { LapPoint } from './analysis.types';
import {
  BRAKING_ENTER_G,
  BRAKING_EXIT_G,
  MIN_BRAKING_MS,
  detectBrakingPoints,
} from './braking-points';

const DT_MS = 100;

/**
 * A lap built from a longitudinal-g script: one entry per 100 ms sample.
 *
 * Speed is integrated from the g values so the two channels agree, which lets
 * the same script drive both the `gLon` path and the speed-differencing
 * fallback.
 */
function lapFromG(gLonScript: number[], startSpeedKmh = 180): LapPoint[] {
  const points: LapPoint[] = [];
  let speedMs = (startSpeedKmh * 1000) / 3600;
  let distM = 0;

  points.push({
    timeMs: 0,
    lat: 42.34,
    lon: 24.73,
    distM: 0,
    speedKmh: startSpeedKmh,
    gLon: 0,
  });

  gLonScript.forEach((gLon, i) => {
    speedMs = Math.max(speedMs + gLon * 9.80665 * (DT_MS / 1000), 1);
    distM += speedMs * (DT_MS / 1000);

    points.push({
      timeMs: (i + 1) * DT_MS,
      lat: 42.34 + distM / 111132,
      lon: 24.73,
      distM,
      speedKmh: speedMs * 3.6,
      gLon,
    });
  });

  return points;
}

/** n samples of steady deceleration at `g`. */
const brake = (g: number, n: number): number[] => Array<number>(n).fill(-g);
const cruise = (n: number): number[] => Array<number>(n).fill(0);

describe('detectBrakingPoints', () => {
  it('finds one marker per sustained braking zone', () => {
    const lap = lapFromG([
      ...cruise(10),
      ...brake(1.0, 10),
      ...cruise(20),
      ...brake(0.8, 10),
      ...cruise(10),
    ]);

    const zones = detectBrakingPoints(lap);

    expect(zones).toHaveLength(2);
    expect(zones[0].peakDecelG).toBeCloseTo(1.0, 2);
    expect(zones[1].peakDecelG).toBeCloseTo(0.8, 2);
  });

  it('marks where the driver hit the pedal, not where the car slowed', () => {
    const lap = lapFromG([...cruise(10), ...brake(1.0, 10), ...cruise(10)]);
    const [zone] = detectBrakingPoints(lap);

    // Braking starts at sample 11 in the script, which is the transition from
    // the sample before it — so the marker belongs at sample 10's position.
    expect(zone.distM).toBeCloseTo(lap[10].distM, 0);
    expect(zone.entrySpeedKmh).toBeCloseTo(180, 0);
  });

  it('ignores a lift off the throttle', () => {
    // Coasting drag is real deceleration and is not a braking point. The
    // threshold is the whole difference between a useful marker set and one
    // with a dozen entries a driver would not recognise.
    const lap = lapFromG([
      ...cruise(10),
      ...brake(BRAKING_ENTER_G - 0.05, 20),
      ...cruise(10),
    ]);

    expect(detectBrakingPoints(lap)).toEqual([]);
  });

  it('ignores a stab too brief to be a braking zone', () => {
    const samples = Math.floor(MIN_BRAKING_MS / DT_MS) - 1;
    const lap = lapFromG([
      ...cruise(10),
      ...brake(1.2, samples),
      ...cruise(10),
    ]);

    expect(detectBrakingPoints(lap)).toEqual([]);
  });

  it('holds a zone open through a momentary ease', () => {
    // Trail-braking towards the apex routinely dips under the entry threshold
    // for a sample or two. Without the hysteresis this reads as two zones.
    const lap = lapFromG([
      ...cruise(10),
      ...brake(1.0, 6),
      ...brake(BRAKING_EXIT_G + 0.02, 2),
      ...brake(1.0, 6),
      ...cruise(10),
    ]);

    expect(detectBrakingPoints(lap)).toHaveLength(1);
  });

  it('merges two zones separated by a brief release', () => {
    // Off the brakes entirely for 200 ms between two apexes of one complex —
    // below the hysteresis floor, so only the merge window catches it. Left
    // unmerged, the marker count swings lap to lap as pace moves a fragment
    // across the threshold.
    const lap = lapFromG([
      ...cruise(10),
      ...brake(1.0, 6),
      ...cruise(2),
      ...brake(1.0, 6),
      ...cruise(10),
    ]);

    const zones = detectBrakingPoints(lap);
    expect(zones).toHaveLength(1);
    expect(zones[0].distM).toBeCloseTo(lap[10].distM, 0);
  });

  it('merges into a zone re-opened by the very last sample', () => {
    // Two fragments, each too short to count on its own, separated by a release
    // inside the merge window — and the second one starts on the final sample
    // of the lap, so there is no next iteration to carry the merged zone's end
    // forward. Left to that iteration, the zone is pushed with the end it had
    // before the merge and the duration test throws away a real marker.
    const lap = lapFromG([
      ...cruise(10),
      ...brake(1.0, 1),
      ...cruise(2),
      ...brake(1.0, 1),
    ]);

    const zones = detectBrakingPoints(lap);

    expect(zones).toHaveLength(1);
    expect(zones[0].distM).toBeCloseTo(lap[10].distM, 0);
  });

  it('keeps two genuinely separate zones apart', () => {
    // A full second of nothing between them: two corners, two markers.
    const lap = lapFromG([
      ...cruise(10),
      ...brake(1.0, 6),
      ...cruise(10),
      ...brake(1.0, 6),
      ...cruise(10),
    ]);

    expect(detectBrakingPoints(lap)).toHaveLength(2);
  });

  it('closes a zone still open at the finish line', () => {
    // The car brakes into the final corner and crosses the line still on the
    // brakes. Dropping it would lose a marker from every lap of a circuit
    // whose S/F sits on a corner exit.
    const lap = lapFromG([...cruise(10), ...brake(1.0, 10)]);

    expect(detectBrakingPoints(lap)).toHaveLength(1);
  });

  it('falls back to differencing speed when there is no g channel', () => {
    // The `--replay` path for a dash session record carries geometry and lap
    // times and no accelerometer data at all. A detector that silently
    // returned nothing for those sessions would look like a car that never
    // brakes.
    const script = [...cruise(10), ...brake(1.0, 10), ...cruise(10)];
    const withG = detectBrakingPoints(lapFromG(script));
    const withoutG = detectBrakingPoints(
      lapFromG(script).map((point) => ({ ...point, gLon: undefined })),
    );

    expect(withoutG).toHaveLength(withG.length);
    expect(withoutG[0].peakDecelG).toBeCloseTo(withG[0].peakDecelG, 1);
    expect(withoutG[0].distM).toBeCloseTo(withG[0].distM, 0);
  });

  it('reports nothing when neither channel is available', () => {
    const lap = lapFromG([...cruise(10), ...brake(1.0, 10)]).map((point) => ({
      ...point,
      gLon: undefined,
      speedKmh: undefined,
    }));

    expect(detectBrakingPoints(lap)).toEqual([]);
  });

  it('reports nothing for an empty lap', () => {
    expect(detectBrakingPoints([])).toEqual([]);
  });
});
