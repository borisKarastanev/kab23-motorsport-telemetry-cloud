import { Bounds, WorldPoint } from './canvas-viewport';

/**
 * Lat/lon → canvas world space, and the smoothing the racing line draws through.
 * Pure, and shared by `racing-line.ts` and `track-trace.ts` so the two views
 * cannot drift apart on projection.
 */

/** Metres per degree of latitude — good enough for a visual overlay, not survey work. */
export const METERS_PER_DEG_LAT = 111_320;

export interface LatLon {
  lat: number;
  lon: number;
}

/**
 * An equirectangular projection into **local metres around `origin`**
 * (x east, y south, so north stays up on a canvas).
 *
 * Metres, not degrees, because canvas paths are 32-bit floats: at 42° a float32
 * degree steps by ~0.4 m, which staircases the line and, once zoomed in, breaks
 * it into dashes. Near an origin the values stay small and precise.
 *
 * Every layer in one view (lap, ghost, circuit, markers) must share one origin.
 */
export function localProjection(origin: LatLon): (p: LatLon) => WorldPoint {
  const mPerDegLon = METERS_PER_DEG_LAT * Math.cos((origin.lat * Math.PI) / 180);
  return (p) => ({
    x: (p.lon - origin.lon) * mPerDegLon,
    y: -(p.lat - origin.lat) * METERS_PER_DEG_LAT,
  });
}

/**
 * A circuit's GeoJSON `[lon, lat]` ring projected around its own first point —
 * which both views anchor on, so they place the circuit identically — with the
 * projection itself (for corners and other layers) and the ring's bounds.
 */
export function projectCircuit(coordinates: number[][]): {
  origin: LatLon;
  project: (p: LatLon) => WorldPoint;
  points: WorldPoint[];
  bounds: Bounds;
} {
  const origin = { lat: coordinates[0][1], lon: coordinates[0][0] };
  const project = localProjection(origin);
  const points = coordinates.map(([lon, lat]) => project({ lat, lon }));
  return { origin, project, points, bounds: boundsOf([points]) };
}

/** The bounds of every point in `lists`, grown from `seed` when given. */
export function boundsOf(lists: WorldPoint[][], seed?: Bounds): Bounds {
  const b = seed
    ? { ...seed }
    : { minX: Infinity, maxX: -Infinity, minY: Infinity, maxY: -Infinity };
  for (const list of lists) {
    for (const p of list) {
      b.minX = Math.min(b.minX, p.x);
      b.maxX = Math.max(b.maxX, p.x);
      b.minY = Math.min(b.minY, p.y);
      b.maxY = Math.max(b.maxY, p.y);
    }
  }
  return b;
}

/** Smallest smoothing radius, in metres — a few times a 10 Hz GNSS fix's ~1σ noise. */
const MIN_SMOOTHING_SIGMA_M = 3;
/** Smoothing radius as a multiple of the trace's typical spacing between samples. */
const SMOOTHING_SAMPLES = 1.5;

/**
 * The Gaussian width for a trace sampled at `distM`: scaled to the median
 * sample spacing so a fast lap still averages a few fixes, floored so a slow
 * one is smoothed over more than the noise. A Gaussian cuts an arc of radius R
 * by about σ²/2R — ~0.45 m at σ = 3 m on a 10 m hairpin, well inside a track.
 */
export function smoothingSigmaM(distM: number[]): number {
  if (distM.length < 2) {
    return MIN_SMOOTHING_SIGMA_M;
  }
  const steps = distM.slice(1).map((d, i) => d - distM[i]);
  steps.sort((a, b) => a - b);
  return Math.max(MIN_SMOOTHING_SIGMA_M, steps[Math.floor(steps.length / 2)] * SMOOTHING_SAMPLES);
}

/**
 * Whether every entry of `distM` is finite. A replayed dash record can lack a
 * distance channel, and one NaN would otherwise blank the whole smoothed lap.
 */
export function isUsableDistance(distM: number[]): boolean {
  return distM.every(Number.isFinite);
}

/**
 * The trace with GNSS jitter averaged out: a Gaussian-weighted mean of each
 * point's neighbours **by distance along the lap**, not by index, so slow
 * corners and fast straights are smoothed over the same stretch of track.
 * Presentation only — laps, sectors and braking points come from the raw
 * samples server-side.
 *
 * `distM` must be non-decreasing and as long as `points`; if it is not usable
 * the points come back as they were. The first and last points are pinned: a
 * one-sided average would pull them off the start/finish gate.
 */
export function smoothAlongDistance(
  points: WorldPoint[],
  distM: number[],
  sigmaM: number,
): WorldPoint[] {
  const n = points.length;
  if (n < 3 || !(sigmaM > 0) || !isUsableDistance(distM)) {
    return points;
  }

  const reach = 3 * sigmaM;
  const inv = 1 / (2 * sigmaM * sigmaM);
  const out: WorldPoint[] = new Array(n);
  out[0] = points[0];
  out[n - 1] = points[n - 1];
  let lo = 0;
  let hi = 0;

  for (let i = 1; i < n - 1; i++) {
    while (distM[i] - distM[lo] > reach) {
      lo++;
    }
    hi = Math.max(hi, i);
    while (hi + 1 < n && distM[hi + 1] - distM[i] <= reach) {
      hi++;
    }

    let sx = 0;
    let sy = 0;
    let sw = 0;
    for (let j = lo; j <= hi; j++) {
      const d = distM[j] - distM[i];
      const w = Math.exp(-d * d * inv);
      sx += w * points[j].x;
      sy += w * points[j].y;
      sw += w;
    }
    out[i] = { x: sx / sw, y: sy / sw };
  }

  return out;
}

/**
 * The point `atM` metres into the lap along `points`, interpolated between the
 * samples either side and clamped to the ends. Places braking markers on the
 * smoothed line instead of at their raw fix, beside it.
 */
export function pointAtDistance(points: WorldPoint[], distM: number[], atM: number): WorldPoint {
  const n = points.length;
  if (atM <= distM[0]) {
    return points[0];
  }
  if (atM >= distM[n - 1]) {
    return points[n - 1];
  }

  let lo = 0;
  let hi = n - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (distM[mid] <= atM) {
      lo = mid;
    } else {
      hi = mid;
    }
  }

  // distM[lo] <= atM < distM[hi] by construction, so the span is never zero.
  const t = (atM - distM[lo]) / (distM[hi] - distM[lo]);
  return {
    x: points[lo].x + t * (points[hi].x - points[lo].x),
    y: points[lo].y + t * (points[hi].y - points[lo].y),
  };
}
