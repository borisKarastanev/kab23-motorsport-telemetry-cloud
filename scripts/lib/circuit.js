'use strict';

/**
 * A real circuit shape the mock publisher can drive, anchored on a real
 * confirmed start/finish gate.
 *
 * ## Why this exists
 *
 * The Phase 4 prerequisite (see `~/development/motorsport-cloud-architecture.md`
 * § 8) says the mock's ~110 m circle "can never produce a meaningful S/F
 * crossing". The circle is not really the problem — the dash's own
 * `MockRaceBoxProvider` is a circle too, and times laps fine, because it places
 * its gate perpendicular to the path and offsets the lap seam so the car cuts
 * the line cleanly mid-lap. The three real problems with the old mock were:
 *
 * 1. **No gate at all**, and coordinates (42.61, 24.98) nowhere near the
 *    Kaloyanovo entry in the track database, so nothing could ever be matched
 *    against a known S/F line.
 * 2. **A constant-radius path**, which has no braking zones and no sectors
 *    worth splitting — every point on a circle looks like every other.
 * 3. **Channels unrelated to the path.** Speed, rpm and g were independent sine
 *    waves. A braking-point detector run against that is a detector run against
 *    noise: it would "find" decelerations that correspond to nothing the car
 *    did.
 *
 * So this module fixes all three: a real multi-corner shape, fitted to a real
 * gate, with speed derived from the geometry.
 *
 * ## What is real and what is not
 *
 * **Real:** the S/F gate and track centre, and — since this shape was
 * replaced — the track's own layout. `WAYPOINTS` is an arc-length-resampled
 * (~40 m spacing) version of one representative lap (the best of six) from an
 * actual recorded drive at Kaloyanovo, converted into the same local metre
 * frame `anchorToGate` uses. `TARGET_LAP_M` is that lap's measured GPS
 * distance, not a guess.
 *
 * **Not real:** speed, rpm and the g channels are still synthesised by the
 * quasi-steady-state simulation below, from this shape's curvature — they are
 * not replayed from the recording. The car that did the real lap pulled more
 * lateral g than this simulation's grip figures assume (a genuine driver on
 * real tyres vs. a conservative fixed limit); that is expected and not a bug
 * to chase.
 *
 * ## How the speed trace is built
 *
 * Curvature first, then a quasi-steady-state lap simulation: cornering speed is
 * capped by lateral grip (`v = sqrt(a_lat / κ)`), then a backward pass applies
 * the braking limit and a forward pass the traction limit, iterated around the
 * closed loop until stable. That is the standard simple lap-sim, and the reason
 * to use it here is that **braking zones fall out of it rather than being drawn
 * in**: the deceleration ramp into a corner is a consequence of the corner's
 * radius and the car's stopping power, so a braking-point detector has
 * something real to find and its answer can be checked against the geometry.
 *
 * Lateral and longitudinal grip are treated as independent limits rather than
 * as a friction ellipse. A real car cannot brake at 1.1 g while pulling 1.2 g
 * laterally; ignoring that makes corner entry slightly optimistic. It is a mock
 * — the shape of the trace is what matters, not the lap record.
 */

const { localFrame } = require('./geo');

const G = 9.80665;

/**
 * Kaloyanovo's confirmed S/F gate and centre.
 *
 * Source: `~/development/kab23-motorsport-race-dash/data/track-db.json`, the
 * `start` field — a flat `[lat1, lon1, lat2, lon2]` pair of gate endpoints.
 * **Only the dash repo's copy has these**; the older `~/development/track-db.json`
 * export carries no `start` fields at all.
 *
 * The gate is ~18 m across, which is a real track width, so a car crossing it
 * transversally produces a crossing well inside the gate's span rather than
 * clipping an endpoint.
 */
const KALOYANOVO = {
  slug: 'kaloyanovo',
  name: 'Kaloyanovo',
  centre: { lat: 42.341337751867, lon: 24.734736084938 },
  gate: {
    lat1: 42.3411288,
    lon1: 24.737,
    lat2: 42.3409841,
    lon2: 24.7369101,
  },
};

/**
 * The circuit's shape, in metres, as a closed list of waypoints.
 *
 * Real, not designed: arc-length resampled at ~40 m spacing from the GPS trace
 * of one lap (the fastest of six, 85.085 s) of an actual recorded drive at
 * Kaloyanovo. Extracted from the dash's session export using the lap boundary
 * the device itself recorded (`meta.laps[3].sensorRecordIndex`), converted into
 * the same local metre frame `anchorToGate` builds from `KALOYANOVO.gate` —
 * so point 0 already sits within noise of the real gate crossing and is
 * snapped to exactly `(0, 0)` to satisfy `anchorToGate`'s assumption that the
 * origin is the S/F point. Everything downstream (the closed Catmull-Rom
 * spline, the scale to `TARGET_LAP_M`, the rotation onto the gate) works
 * exactly as it did for the old hand-drawn shape — only the input changed.
 *
 * No per-corner commentary this time: unlike the old designed shape, these
 * corners were not laid out to exercise anything in particular, they are
 * whatever Kaloyanovo actually does. `circuit.spec.ts` checks the resulting
 * curvature still has the range Phase 4 needs (a genuine slow corner, a
 * genuine straight) against the real numbers.
 */
const WAYPOINTS = [
  { x: 0.0, y: 0.0 },
  { x: -36.5, y: 16.1 },
  { x: -74.1, y: 30.1 },
  { x: -111.2, y: 45.2 },
  { x: -147.1, y: 63.2 },
  { x: -179.7, y: 86.4 },
  { x: -206.7, y: 116.0 },
  { x: -226.1, y: 151.0 },
  { x: -242.6, y: 187.6 },
  { x: -261.7, y: 222.8 },
  { x: -284.7, y: 255.7 },
  { x: -312.6, y: 284.3 },
  { x: -349.7, y: 297.9 },
  { x: -387.3, y: 285.8 },
  { x: -413.0, y: 255.5 },
  { x: -425.8, y: 217.7 },
  { x: -426.0, y: 177.7 },
  { x: -414.9, y: 139.3 },
  { x: -395.6, y: 104.2 },
  { x: -370.6, y: 72.9 },
  { x: -341.7, y: 45.0 },
  { x: -310.9, y: 19.3 },
  { x: -280.1, y: -6.5 },
  { x: -249.6, y: -32.5 },
  { x: -219.3, y: -58.8 },
  { x: -189.1, y: -85.2 },
  { x: -158.9, y: -111.6 },
  { x: -128.9, y: -138.3 },
  { x: -99.1, y: -165.1 },
  { x: -69.4, y: -192.1 },
  { x: -39.6, y: -219.0 },
  { x: -9.1, y: -245.0 },
  { x: 26.7, y: -262.5 },
  { x: 64.7, y: -254.5 },
  { x: 88.8, y: -222.9 },
  { x: 93.4, y: -183.7 },
  { x: 77.7, y: -147.0 },
  { x: 51.8, y: -116.6 },
  { x: 14.5, y: -105.7 },
  { x: -22.9, y: -120.0 },
  { x: -62.5, y: -121.6 },
  { x: -99.5, y: -106.5 },
  { x: -130.6, y: -81.3 },
  { x: -159.6, y: -53.5 },
  { x: -189.3, y: -26.6 },
  { x: -219.5, y: -0.2 },
  { x: -250.1, y: 25.8 },
  { x: -280.8, y: 51.7 },
  { x: -310.9, y: 78.2 },
  { x: -338.5, y: 107.2 },
  { x: -362.4, y: 139.4 },
  { x: -379.3, y: 175.7 },
  { x: -371.9, y: 213.1 },
  { x: -334.8, y: 213.5 },
  { x: -314.5, y: 179.9 },
  { x: -302.7, y: 141.7 },
  { x: -280.0, y: 108.8 },
  { x: -250.4, y: 81.7 },
  { x: -220.4, y: 55.1 },
  { x: -191.2, y: 27.6 },
  { x: -159.4, y: 3.4 },
  { x: -120.0, y: 1.1 },
  { x: -80.1, y: 0.5 },
  { x: -42.6, y: -13.4 },
  { x: -8.2, y: -34.0 },
  { x: 23.6, y: -58.4 },
  { x: 53.2, y: -85.5 },
  { x: 90.0, y: -92.2 },
  { x: 96.8, y: -55.8 },
  { x: 71.6, y: -25.2 },
  { x: 35.5, y: -7.9 },
];

/**
 * Kaloyanovo's actual lap length, from the same recorded lap `WAYPOINTS` came
 * from — summed GPS distance between consecutive samples, not a guess.
 */
const TARGET_LAP_M = 2838;

/** Geometry resolution. 1 m over a 2.8 km lap is ~2 800 points — cheap. */
const RESAMPLE_M = 1;

/**
 * Curvature smoothing half-window, in metres.
 *
 * Menger curvature over a resampled spline is noisy at 1 m spacing — the
 * numerator is a cross product of two nearly-parallel 1 m vectors. Without
 * smoothing the speed profile chatters, and every chatter reads as a braking
 * event.
 *
 * 8 m, chosen by measuring: the window rounds off the tight corners, so it sets
 * how slow the slowest corner is. At 16 m the minimum radius comes out 39 m
 * (77 km/h, not a slow corner at all); at 6 m the curvature starts picking up
 * resampling noise again. 8 m gives a 32 m minimum radius — a genuine
 * second-gear corner — while staying smooth.
 */
const CURVATURE_SMOOTH_M = 8;

// A BMW E46 on track tyres, roughly. These are the knobs that set lap time.
const BASE_LAT_G = 1.2;
const BASE_BRAKE_G = 1.1;
const BASE_ACCEL_G = 0.35; // a 330i is not quick out of a hairpin
const BASE_V_MAX_KMH = 185;

/** Where the car starts, measured back from the line — an out-lap, in effect. */
const GRID_OFFSET_M = 200;

/**
 * GPS noise, metres (1σ, per axis).
 *
 * Non-zero on purpose. A noiseless trace never exercises the segmenter's
 * debounce, which exists precisely because jitter can straddle the line on
 * consecutive fixes. Small enough not to visibly corrupt a racing line.
 */
const DEFAULT_GPS_NOISE_M = 0.7;

/** Per-lap variation, 1σ. This is what gives lap-vs-lap comparison a delta. */
const PACE_SIGMA = 0.015;
const BRAKE_SIGMA = 0.02;

/**
 * A driver's own line varies lap to lap, on top of GPS noise — real racing
 * lines are not a single reused polyline with jitter on it. Without this, two
 * laps compared on the map are pixel-identical (mod ~1 m of GPS noise), which
 * is not what a real multi-lap session ever looks like.
 *
 * Modelled as a smooth per-lap lateral offset from the fitted racing line
 * (`CircuitDriver.newLineOffset`) rather than per-sample noise: a driver
 * chooses one line through a corner and holds it for the corner's duration,
 * they do not wander sideways at 10 Hz. Weighted by curvature so it shows up
 * where a line choice is actually visible — through a corner — and stays near
 * zero on a straight, where a real car tracks the same few centimetres lap
 * after lap.
 */
const LINE_OFFSET_PEAK_M = 1.5;
/** Corner radius, metres, at and below which the lateral offset is at full amplitude. */
const LINE_OFFSET_CORNER_RADIUS_M = 60;
/** Smoothing half-window for the per-lap offset curve, metres — a chosen line, not point noise. */
const LINE_OFFSET_SMOOTH_M = 40;

/**
 * Distance over which a new lap's speed profile is faded in, metres.
 *
 * The car's speed is continuous across the start/finish line; its *profile* is
 * not, because a fresh one is generated per lap with different grip figures.
 * Swapping profiles outright put a ~1.5% speed step into a single 100 ms tick,
 * measured as a **+0.95 g longitudinal spike** sitting exactly on S/F — a
 * phantom braking/acceleration event on every lap, at the one place on the
 * circuit guaranteed to be a straight, and precisely the kind of artefact a
 * braking-point detector would faithfully report.
 *
 * The fade is an *offset* that decays to zero over this distance, anchored on
 * the speed the car actually arrives at. Anchoring on the outgoing profile's
 * index 0 instead — the obvious first attempt — does not work: the car arrives
 * at the line having driven the *new* profile all the way round, so tying index
 * 0 to the old one just moves the discontinuity to the profile's own seam,
 * where it was measured at a worse 1.28 g.
 */
const PROFILE_BLEND_M = 100;

// ---------------------------------------------------------------------------
// Drivetrain
// ---------------------------------------------------------------------------

/** Engine rpm per km/h, per gear. */
const GEAR_RPM_PER_KMH = [120, 78, 56, 43, 35];
const REDLINE_RPM = 7000;
const IDLE_RPM = 850;

/**
 * Engine speed for a road speed, picking the lowest gear that stays under the
 * redline. Exported because the replay sources need it too: a recorded GPS log
 * carries no CAN data, so rpm has to be reconstructed the same way there.
 */
function rpmFor(speedKmh) {
  for (const ratio of GEAR_RPM_PER_KMH) {
    const rpm = speedKmh * ratio;
    if (rpm <= REDLINE_RPM) {
      return Math.max(IDLE_RPM, Math.round(rpm));
    }
  }
  return REDLINE_RPM;
}

// ---------------------------------------------------------------------------
// Geometry
// ---------------------------------------------------------------------------

/** Catmull-Rom through p1→p2, with p0/p3 as the neighbouring control points. */
function catmullRomPoint(p0, p1, p2, p3, t) {
  const t2 = t * t;
  const t3 = t2 * t;
  const axis = (a, b, c, d) =>
    0.5 *
    (2 * b +
      (-a + c) * t +
      (2 * a - 5 * b + 4 * c - d) * t2 +
      (-a + 3 * b - 3 * c + d) * t3);

  return {
    x: axis(p0.x, p1.x, p2.x, p3.x),
    y: axis(p0.y, p1.y, p2.y, p3.y),
  };
}

/**
 * A closed Catmull-Rom spline through the waypoints.
 *
 * Closed rather than open because the track *is* a loop: an open spline would
 * leave a kink at the seam, right where the S/F line is, which is the single
 * worst place on the circuit to put a geometric discontinuity.
 */
function catmullRomClosed(waypoints, samplesPerSegment) {
  const n = waypoints.length;
  const out = [];

  for (let i = 0; i < n; i++) {
    const p0 = waypoints[(i - 1 + n) % n];
    const p1 = waypoints[i];
    const p2 = waypoints[(i + 1) % n];
    const p3 = waypoints[(i + 2) % n];

    for (let k = 0; k < samplesPerSegment; k++) {
      out.push(catmullRomPoint(p0, p1, p2, p3, k / samplesPerSegment));
    }
  }

  return out;
}

/** Total length of a closed polyline. */
function closedLength(polyline) {
  const n = polyline.length;
  let total = 0;

  for (let i = 0; i < n; i++) {
    const a = polyline[i];
    const b = polyline[(i + 1) % n];
    total += Math.hypot(b.x - a.x, b.y - a.y);
  }

  return total;
}

/**
 * Resample a closed polyline to equal arc-length spacing.
 *
 * The step is `total / round(total / targetDs)` rather than `targetDs` itself,
 * so the loop closes exactly on a sample boundary. Left as a ragged remainder,
 * the last segment before S/F would be a different length from all the others,
 * and the curvature estimate there — the one governing the most important
 * corner exit on the lap — would be computed over the wrong baseline.
 */
function resampleClosed(polyline, targetDs) {
  const n = polyline.length;
  const cumulative = new Float64Array(n + 1);

  for (let i = 0; i < n; i++) {
    const a = polyline[i];
    const b = polyline[(i + 1) % n];
    cumulative[i + 1] = cumulative[i] + Math.hypot(b.x - a.x, b.y - a.y);
  }

  const total = cumulative[n];
  const count = Math.max(16, Math.round(total / targetDs));
  const ds = total / count;
  const points = new Array(count);

  let segment = 0;
  for (let k = 0; k < count; k++) {
    const s = k * ds;
    while (segment < n - 1 && cumulative[segment + 1] < s) {
      segment++;
    }

    const a = polyline[segment];
    const b = polyline[(segment + 1) % n];
    const span = cumulative[segment + 1] - cumulative[segment] || 1;
    const f = (s - cumulative[segment]) / span;

    points[k] = { x: a.x + (b.x - a.x) * f, y: a.y + (b.y - a.y) * f, s };
  }

  return { points, ds, lapLengthM: total };
}

/**
 * Signed Menger curvature at each point of a closed, equally-spaced polyline.
 *
 * Signed, not absolute: the sign is which way the car is turning, and it is
 * what gives lateral g a direction. A `gLat` that is always positive would make
 * the g-trace of a left-hander indistinguishable from a right-hander's.
 */
function signedCurvature(points) {
  const n = points.length;
  const kappa = new Float64Array(n);

  for (let i = 0; i < n; i++) {
    const p = points[(i - 1 + n) % n];
    const q = points[i];
    const r = points[(i + 1) % n];

    const ax = q.x - p.x;
    const ay = q.y - p.y;
    const bx = r.x - q.x;
    const by = r.y - q.y;
    const cx = r.x - p.x;
    const cy = r.y - p.y;

    const denominator =
      Math.hypot(ax, ay) * Math.hypot(bx, by) * Math.hypot(cx, cy);

    kappa[i] = denominator > 1e-9 ? (2 * (ax * by - ay * bx)) / denominator : 0;
  }

  return kappa;
}

/**
 * Unit normal (perpendicular to the direction of travel) at each point of a
 * closed, equally-spaced polyline — "which way is sideways" for the per-lap
 * line-offset noise below. Sign is an arbitrary but consistent left/right per
 * point; the noise it is multiplied by is what actually picks a direction.
 */
function unitNormals(points) {
  const n = points.length;
  const normals = new Array(n);

  for (let i = 0; i < n; i++) {
    const p = points[(i - 1 + n) % n];
    const q = points[(i + 1) % n];
    const dx = q.x - p.x;
    const dy = q.y - p.y;
    const len = Math.hypot(dx, dy) || 1;
    normals[i] = { x: -dy / len, y: dx / len };
  }

  return normals;
}

/** Circular moving average — the track has no ends, so neither does the window. */
function smoothClosed(values, halfWindow) {
  const n = values.length;
  const out = new Float64Array(n);

  for (let i = 0; i < n; i++) {
    let sum = 0;
    for (let k = -halfWindow; k <= halfWindow; k++) {
      sum += values[(i + k + n * 2) % n];
    }
    out[i] = sum / (halfWindow * 2 + 1);
  }

  return out;
}

/**
 * Translate the shape onto the real gate.
 *
 * **The gate is the anchor; the path is fitted to it**, not the other way
 * round. `WAYPOINTS[0]` is `(0, 0)`, so the origin maps straight onto the gate
 * midpoint — editing `WAYPOINTS` can change the circuit's shape but can never
 * move it off the line, which is the failure the old mock had.
 *
 * **No rotation, deliberately.** An earlier version rotated the shape so it
 * crossed the gate at the gate segment's exact mathematical normal, which the
 * old hand-drawn, arbitrarily-oriented `WAYPOINTS` needed. Real GPS data
 * already carries the true recorded heading through the gate, so that rotation
 * turns an already-correctly-oriented shape by whatever the (small, genuine)
 * difference is between how the car actually crossed the line and that
 * idealised perpendicular. Its effect is zero at S/F and grows with distance
 * from it: a ~6° mismatch put the far side of the real Kaloyanovo loop about
 * 50 m off the OSM-derived outline the live view draws underneath it. The
 * transversal-crossing test in `circuit.spec.ts` passes without it — the real
 * crossing is close enough to perpendicular on its own.
 */
function anchorToGate(points, gate) {
  const frame = localFrame((gate.lat1 + gate.lat2) / 2, (gate.lon1 + gate.lon2) / 2);

  return points.map((point) => {
    const { lat, lon } = frame.toGeo(point.x, point.y);
    return { ...point, lat, lon };
  });
}

/**
 * Build the circuit geometry: resampled points with lat/lon, plus curvature.
 *
 * Pure and deterministic — no randomness here. Per-lap variation lives in the
 * speed profile (`CircuitDriver`), because the track does not change shape
 * between laps but the driver's pace does.
 */
function buildCircuit({
  gate = KALOYANOVO.gate,
  targetLapM = TARGET_LAP_M,
  resampleM = RESAMPLE_M,
} = {}) {
  const spline = catmullRomClosed(WAYPOINTS, 24);

  // Scale about the origin, which leaves S/F at the origin and — being a
  // uniform scale — leaves every heading, including the one `anchorToGate`
  // measures, unchanged.
  const scale = targetLapM / closedLength(spline);
  const scaled = spline.map((p) => ({ x: p.x * scale, y: p.y * scale }));

  const { points, ds, lapLengthM } = resampleClosed(scaled, resampleM);
  const kappa = smoothClosed(
    signedCurvature(points),
    Math.max(1, Math.round(CURVATURE_SMOOTH_M / ds)),
  );

  return {
    points: anchorToGate(points, gate),
    kappa,
    ds,
    lapLengthM,
    frame: localFrame((gate.lat1 + gate.lat2) / 2, (gate.lon1 + gate.lon2) / 2),
  };
}

// ---------------------------------------------------------------------------
// Speed
// ---------------------------------------------------------------------------

/**
 * Quasi-steady-state speed around the lap, in m/s.
 *
 * Three stages: the cornering limit from lateral grip, then a backward pass for
 * braking and a forward pass for traction, iterated because the track is a loop
 * and a braking zone can reach back across the S/F line.
 *
 * Two passes would very nearly do; three is cheap insurance for a shape whose
 * slowest corner is a long way from the seam.
 */
function speedProfile(kappa, ds, { latG, brakeG, accelG, vMaxKmh }) {
  const n = kappa.length;
  const vMax = vMaxKmh / 3.6;
  const v = new Float64Array(n);

  for (let i = 0; i < n; i++) {
    const radiusLimit = Math.sqrt(
      (latG * G) / Math.max(Math.abs(kappa[i]), 1e-6),
    );
    v[i] = Math.min(vMax, radiusLimit);
  }

  const brakeStep = 2 * brakeG * G * ds;
  const accelStep = 2 * accelG * G * ds;

  for (let pass = 0; pass < 3; pass++) {
    // Backward: how fast may the car be *here* and still make the next corner?
    for (let i = n - 1; i >= 0; i--) {
      const next = v[(i + 1) % n];
      v[i] = Math.min(v[i], Math.sqrt(next * next + brakeStep));
    }
    // Forward: how fast can it actually have got to, coming out of the last?
    for (let i = 0; i < n; i++) {
      const previous = v[(i - 1 + n) % n];
      v[i] = Math.min(v[i], Math.sqrt(previous * previous + accelStep));
    }
  }

  return v;
}

// ---------------------------------------------------------------------------
// Driving
// ---------------------------------------------------------------------------

/** Seeded PRNG, so a failing test is reproducible. */
function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Standard normal, Box-Muller over any `() => number` uniform stream. */
function gaussianFrom(random) {
  const u = Math.max(random(), Number.EPSILON);
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * random());
}

/**
 * Drives the circuit, producing one physical sample per tick.
 *
 * The fitted racing line (`points`, `kappa`, `normals`) is built once; the
 * speed profile and the lateral line offset are both regenerated per lap —
 * from jittered grip figures and freshly smoothed noise respectively — and
 * both are deliberate for the same reason: varying grip moves the braking
 * points and the corner speeds *together and consistently*, the way a
 * driver's pace actually varies, and varying the line the same way moves a
 * whole corner's worth of position *together*, the way a driver's line
 * actually varies — rather than dithering each channel or each sample
 * independently, which is exactly the flaw in the mock this replaces.
 */
class CircuitDriver {
  constructor({
    track = KALOYANOVO,
    targetLapM = TARGET_LAP_M,
    seed = 20260805,
    gpsNoiseM = DEFAULT_GPS_NOISE_M,
  } = {}) {
    this.track = track;
    this.gpsNoiseM = gpsNoiseM;
    this.random = mulberry32(seed);
    // A second, independent stream for `newLineOffset` rather than sharing
    // `this.random`: that draws ~2 800 numbers per lap (one per resampled
    // point), and sharing a stream means every later pace/brake/GPS-noise
    // draw that lap shifts by that same ~2 800, changing values it has no
    // business changing. Adding or resizing the line-offset noise must not
    // reshuffle a single other channel's numbers.
    this.lineRandom = mulberry32(seed ^ 0x9e3779b9);

    const geometry = buildCircuit({ gate: track.gate, targetLapM });
    this.points = geometry.points;
    this.kappa = geometry.kappa;
    this.ds = geometry.ds;
    this.lapLengthM = geometry.lapLengthM;
    this.frame = geometry.frame;
    // Fixed by the shape, not the lap — computed once, unlike `lineOffsetM`.
    this.normals = unitNormals(this.points);

    // Start short of the line rather than on it. The car then reaches S/F a few
    // seconds in, which both looks like a real out-lap and gets the segmenter's
    // arming crossing out of the way early.
    this.distanceM = this.lapLengthM - GRID_OFFSET_M;

    // Lap 0 is the out-lap: not timed, exactly as the dash's `m_lapNumber`
    // stays 0 until the first accepted crossing. Keeping the same convention is
    // what makes the device's own lap number directly comparable with the lap
    // numbers the cloud derives.
    this.lap = 0;
    this.lapMs = 0;
    this.topSpeedKmh = 0;
    this.completedLapMs = [];

    this.speed = this.newLapProfile();
    this.lineOffsetM = this.newLineOffset();
    this.previousSpeedMs = this.speedAt(this.distanceM);
  }

  /** Standard normal, Box-Muller over the seeded uniform stream. */
  gaussian() {
    return gaussianFrom(this.random);
  }

  /**
   * A lap's speed profile, with this lap's pace baked in.
   *
   * Braking gets its own jitter on top of the overall pace so that braking
   * points move somewhat independently of corner speeds — which is what makes
   * a lap-vs-lap delta trace interesting rather than a flat offset.
   */
  newLapProfile() {
    const pace = 1 + this.gaussian() * PACE_SIGMA;

    return speedProfile(this.kappa, this.ds, {
      latG: BASE_LAT_G * pace,
      brakeG: BASE_BRAKE_G * pace * (1 + this.gaussian() * BRAKE_SIGMA),
      accelG: BASE_ACCEL_G * pace,
      vMaxKmh: BASE_V_MAX_KMH,
    });
  }

  /**
   * This lap's chosen line, as a lateral offset (metres, signed) from the
   * fitted racing line at each point — see `LINE_OFFSET_PEAK_M`.
   *
   * White noise smoothed with the same circular moving average the curvature
   * itself uses, so the result reads as a driver's continuous line choice
   * rather than point-to-point jitter, then rescaled so its peak deviation is
   * exactly `LINE_OFFSET_PEAK_M` before the curvature weighting suppresses
   * most of that peak away on the straights.
   */
  newLineOffset() {
    const n = this.kappa.length;
    const raw = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      raw[i] = gaussianFrom(this.lineRandom);
    }

    const smoothed = smoothClosed(
      raw,
      Math.max(1, Math.round(LINE_OFFSET_SMOOTH_M / this.ds)),
    );

    let peak = 0;
    for (const v of smoothed) {
      peak = Math.max(peak, Math.abs(v));
    }
    const normalise = peak > 1e-9 ? LINE_OFFSET_PEAK_M / peak : 0;

    const offset = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      const cornerWeight = Math.min(
        1,
        Math.abs(this.kappa[i]) * LINE_OFFSET_CORNER_RADIUS_M,
      );
      offset[i] = smoothed[i] * normalise * cornerWeight;
    }

    return offset;
  }

  /**
   * The next lap's profile, anchored on the speed the car crosses the line at.
   *
   * The correction is `arrivalSpeed - next[0]` at index 0, decaying linearly to
   * nothing by `PROFILE_BLEND_M`. That makes the car's speed exactly continuous
   * across S/F while leaving the rest of the lap as the profile solved it. See
   * the constant for the two ways of getting this wrong.
   */
  blendIntoNextLap(arrivalSpeedMs) {
    const next = this.newLapProfile();
    const blendPoints = Math.min(
      Math.round(PROFILE_BLEND_M / this.ds),
      next.length,
    );

    const offset = arrivalSpeedMs - next[0];

    for (let i = 0; i < blendPoints; i++) {
      next[i] += offset * (1 - i / blendPoints);
    }

    return next;
  }

  /** Index into the per-metre arrays for a distance along the lap. */
  indexAt(distanceM) {
    const n = this.points.length;
    const raw = distanceM / this.ds;
    const i0 = ((Math.floor(raw) % n) + n) % n;
    return { i0, i1: (i0 + 1) % n, f: raw - Math.floor(raw) };
  }

  /** Interpolated speed, m/s. */
  speedAt(distanceM) {
    const { i0, i1, f } = this.indexAt(distanceM);
    return this.speed[i0] + (this.speed[i1] - this.speed[i0]) * f;
  }

  /**
   * Advance by `dtMs` and return the sample at the new position.
   *
   * Explicit Euler on distance — the speed at the tick's start is used for the
   * whole tick. At 10 Hz and 50 m/s that is a ~5 m step, and the error against a
   * midpoint rule is well inside the GPS noise this same function adds.
   */
  step(dtMs) {
    const dt = dtMs / 1000;

    const entrySpeedMs = this.speedAt(this.distanceM);
    this.distanceM += entrySpeedMs * dt;
    this.lapMs += dtMs;

    if (this.distanceM >= this.lapLengthM) {
      this.distanceM -= this.lapLengthM;

      // How long ago the car actually crossed the line, at the speed it was
      // doing over this step. Without it the lap clock would be reset at the
      // tick that *noticed* the crossing rather than at the crossing, and every
      // reported lap time would carry up to a full tick — 100 ms — of
      // quantisation from each end.
      //
      // That is not cosmetic. These numbers exist to be checked against the
      // segmenter's, which interpolates the crossing sub-sample; a device-side
      // time that is only good to ±100 ms makes any disagreement below 100 ms
      // meaningless, which is most of the disagreements worth catching.
      const overshootMs =
        entrySpeedMs > 0 ? (this.distanceM / entrySpeedMs) * 1000 : 0;

      // Lap 0 is the out-lap, so it produces no lap time — the first crossing
      // starts the clock, it does not stop anything.
      if (this.lap > 0) {
        this.completedLapMs.push(Math.round(this.lapMs - overshootMs));
      }

      this.lap += 1;
      // The new lap is already `overshootMs` old: the car crossed the line
      // partway through this step. Carrying it rather than zeroing is what
      // makes the *next* lap's time exact too.
      this.lapMs = overshootMs;
      // `previousSpeedMs` is not updated until the end of this tick, so it still
      // holds the speed the car crossed the line at — the anchor the new
      // profile has to start from.
      this.speed = this.blendIntoNextLap(this.previousSpeedMs);
      // A new lap, a newly chosen line — see `newLineOffset`. Unlike the speed
      // profile this needs no blend at the seam: at ~1.5 m peak, nowhere near
      // enough to threaten an 18 m gate, and a driver's line does shift lap to
      // lap on the pit straight same as anywhere else.
      this.lineOffsetM = this.newLineOffset();
    }

    const { i0, i1, f } = this.indexAt(this.distanceM);
    const p0 = this.points[i0];
    const p1 = this.points[i1];
    const n0 = this.normals[i0];
    const n1 = this.normals[i1];

    const speedMs = this.speedAt(this.distanceM);
    const speedKmh = speedMs * 3.6;
    const kappa = this.kappa[i0] + (this.kappa[i1] - this.kappa[i0]) * f;
    const lineOffsetM =
      this.lineOffsetM[i0] + (this.lineOffsetM[i1] - this.lineOffsetM[i0]) * f;
    const normalX = n0.x + (n1.x - n0.x) * f;
    const normalY = n0.y + (n1.y - n0.y) * f;

    // Longitudinal g from the actual change in speed, so a braking zone in the
    // profile is a braking zone in the g trace — they cannot disagree.
    const gLon = (speedMs - this.previousSpeedMs) / dt / G;
    this.previousSpeedMs = speedMs;
    this.topSpeedKmh = Math.max(this.topSpeedKmh, speedKmh);

    // Interpolate in the local metric frame, add this lap's line offset
    // sideways, then GPS noise on top of that, then project once. Adding
    // noise in degrees would stretch it east-west.
    const x =
      p0.x +
      (p1.x - p0.x) * f +
      normalX * lineOffsetM +
      this.gaussian() * this.gpsNoiseM;
    const y =
      p0.y +
      (p1.y - p0.y) * f +
      normalY * lineOffsetM +
      this.gaussian() * this.gpsNoiseM;
    const { lat, lon } = this.frame.toGeo(x, y);

    return {
      lat,
      lon,
      speedKmh,
      rpm: rpmFor(speedKmh),
      gLat: (speedMs * speedMs * kappa) / G,
      gLon,
      gVert: 1 + this.gaussian() * 0.05,
      lap: this.lap,
      lapMs: Math.round(this.lapMs),
      distanceM: this.distanceM,
    };
  }
}

module.exports = {
  KALOYANOVO,
  WAYPOINTS,
  TARGET_LAP_M,
  CircuitDriver,
  buildCircuit,
  speedProfile,
  rpmFor,
};
