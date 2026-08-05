import { AnalysisSample, LapPoint } from './analysis.types';
import { distanceM } from './geo';

/**
 * The lap's distance axis — how far round the car is, at every sample.
 *
 * Shared between the segmenter (which builds it incrementally as it walks the
 * session) and the trace/compare endpoints (which rebuild it for one lap's
 * window). One implementation, because the distance a braking point is stored
 * at and the distance the map draws it at have to be the same number.
 */

/**
 * Distance covered between two points, in metres.
 *
 * **Integrated from speed when speed is available, not differenced from the
 * positions.** Differencing consecutive fixes sums the noise as well as the
 * travel, and the error is one-signed: `hypot` of a true step plus jitter is
 * always longer than the true step, never shorter. Measured against the mock's
 * 2 100 m circuit, position differencing returns 2 195–2 217 m — a consistent
 * 5 % long, varying by up to 1 % lap to lap on nothing but noise. Speed
 * integration returns 2 099–2 101 m, varying by 0.1 %.
 *
 * That lap-to-lap variation is what makes this worth doing rather than merely
 * tidy: `compare` aligns two laps on this axis, so 20 m of accumulated
 * disagreement by the end of a lap is half a second of delta the driver never
 * lost. Doppler-derived GPS speed is the more accurate channel on real hardware
 * too, for the same reason it is here.
 *
 * Falls back to the geometry when speed is missing: a mid-lap dropout should
 * cost accuracy over one interval, not invalidate the lap's distance axis.
 */
export function stepM(
  from: Pick<LapPoint, 'timeMs' | 'lat' | 'lon' | 'speedKmh'>,
  to: Pick<LapPoint, 'timeMs' | 'lat' | 'lon' | 'speedKmh'>,
): number {
  if (from.speedKmh != null && to.speedKmh != null) {
    const dtS = (to.timeMs - from.timeMs) / 1000;
    if (dtS > 0) {
      // Trapezoidal: the speed at both ends, not just at one, so a hard
      // braking zone is not measured at its entry speed throughout.
      return (((from.speedKmh + to.speedKmh) / 2) * 1000 * dtS) / 3600;
    }
  }

  return distanceM(from.lat, from.lon, to.lat, to.lon);
}

/**
 * Turn a lap's samples into distance-indexed points, dropping fixes with no
 * position — they cannot sit on a racing line, and drawing them at (0, 0) puts
 * the car in the Gulf of Guinea.
 */
export function toLapPoints(samples: AnalysisSample[]): LapPoint[] {
  const points: LapPoint[] = [];

  for (const sample of samples) {
    if (!Number.isFinite(sample.lat) || !Number.isFinite(sample.lon)) {
      continue;
    }

    const point: LapPoint = {
      timeMs: sample.time.getTime(),
      lat: sample.lat,
      lon: sample.lon,
      distM: 0,
      speedKmh: sample.speedKmh,
      gLon: sample.gLon,
    };

    const previous = points[points.length - 1];
    if (previous) {
      point.distM = previous.distM + stepM(previous, point);
    }

    points.push(point);
  }

  return points;
}
