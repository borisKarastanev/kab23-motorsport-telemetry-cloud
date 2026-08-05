'use strict';

/**
 * A synthetic circuit the mock publisher can actually drive, anchored on a real
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
 * So this module fixes all three: a designed multi-corner shape, fitted to a
 * real gate, with speed derived from the geometry.
 *
 * ## What is real and what is not
 *
 * **Real:** the S/F gate, copied verbatim out of the dash's
 * `data/track-db.json` `start` field, and the track centre. Only three tracks
 * in that database carry a confirmed gate.
 *
 * **Not real:** the shape. This is a plausible club circuit, not a survey of
 * Kaloyanovo. It exists to exercise segmentation, sector splits and
 * braking-point detection, and it is fitted to the real gate so that everything
 * downstream — the `tracks` table, the segmenter — is exercised against
 * coordinates it will genuinely see.
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
 * Laid out with the S/F line at the origin and the main straight running along
 * +x, then smoothed with a closed Catmull-Rom spline and scaled to
 * `TARGET_LAP_M`. The whole thing is rotated and translated onto the real gate
 * afterwards (`anchorToGate`), so these numbers are pure shape — changing them
 * cannot move the track off the gate.
 *
 * Designed to contain the features Phase 4 needs to detect: one long straight
 * ending in a heavy braking zone, a fast sweeper that should *not* register as
 * braking, a pair of esses, and a hairpin — the slowest point on the lap and
 * the one a sector split must land near.
 */
const WAYPOINTS = [
  { x: 0, y: 0 }, //     S/F, on the main straight
  { x: 170, y: 3 },
  { x: 340, y: 10 },
  { x: 430, y: 16 }, //  end of the main straight — the lap's heaviest braking
  { x: 496, y: 40 }, //  T1 entry
  { x: 524, y: 84 }, //  T1 apex, medium
  { x: 528, y: 140 },
  { x: 520, y: 196 }, // T2 entry
  { x: 486, y: 232 }, // T2 apex, tight
  { x: 432, y: 240 },
  { x: 382, y: 224 }, // T3, first of the esses
  { x: 352, y: 192 },
  { x: 316, y: 190 }, // T4, second of the esses — no braking between them
  { x: 286, y: 222 },
  { x: 240, y: 246 },
  { x: 186, y: 250 }, // T5 entry
  { x: 150, y: 226 }, // T5 apex, tight
  { x: 146, y: 186 },
  { x: 158, y: 140 },
  { x: 150, y: 104 }, // T6 entry — the slowest corner on the lap
  { x: 118, y: 78 }, //  T6 apex
  { x: 76, y: 86 }, //   T6 exit, swinging back west
  { x: 40, y: 116 },
  { x: -6, y: 130 }, //  T7 entry
  { x: -54, y: 116 }, // T7 apex
  { x: -78, y: 76 },
  { x: -70, y: 34 }, //  T8, the final corner
  { x: -40, y: 8 }, //   onto the main straight
];

/** Kaloyanovo is a ~2.1 km circuit; the shape above is scaled to match. */
const TARGET_LAP_M = 2100;

/** Geometry resolution. 1 m over a 2.1 km lap is ~2 100 points — cheap. */
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
 * Rotate and translate the shape so it crosses the real gate perpendicularly.
 *
 * **The gate is the anchor; the path is fitted to it**, not the other way
 * round. The rotation is derived from the gate's own endpoints and the shape's
 * tangent at s = 0, so editing `WAYPOINTS` can change the circuit's shape but
 * can never move it off the line — which is the failure the old mock had.
 *
 * A perpendicular crossing is not cosmetic. The segmenter intersects the path
 * segment against the gate segment and rejects anything outside either span; a
 * shallow crossing would clip a gate endpoint and drop laps intermittently,
 * which is the hardest kind of bug to tell apart from a real one.
 */
function anchorToGate(points, gate) {
  const midLat = (gate.lat1 + gate.lat2) / 2;
  const midLon = (gate.lon1 + gate.lon2) / 2;
  const frame = localFrame(midLat, midLon);

  const a = frame.toLocal(gate.lat1, gate.lon1);
  const b = frame.toLocal(gate.lat2, gate.lon2);

  // The racing direction is the gate's normal: rotate A→B by −90°.
  const gateX = b.x - a.x;
  const gateY = b.y - a.y;
  const targetAngle = Math.atan2(-gateX, gateY);

  // The shape's heading at S/F, by central difference across the seam.
  const n = points.length;
  const currentAngle = Math.atan2(
    points[1].y - points[n - 1].y,
    points[1].x - points[n - 1].x,
  );

  const rotation = targetAngle - currentAngle;
  const cos = Math.cos(rotation);
  const sin = Math.sin(rotation);

  // Rotation is about the origin, which is where `WAYPOINTS[0]` — the S/F point
  // — sits, so the origin maps straight onto the gate midpoint.
  return points.map((point) => {
    const x = point.x * cos - point.y * sin;
    const y = point.x * sin + point.y * cos;
    const { lat, lon } = frame.toGeo(x, y);
    return { ...point, x, y, lat, lon };
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
    const radiusLimit = Math.sqrt((latG * G) / Math.max(Math.abs(kappa[i]), 1e-6));
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

/**
 * Drives the circuit, producing one physical sample per tick.
 *
 * The shape is built once; only the speed profile is regenerated per lap, from
 * jittered grip figures. That is deliberate: varying grip moves the braking
 * points and the corner speeds *together and consistently*, the way a driver's
 * pace actually varies, rather than dithering each channel independently — which
 * is exactly the flaw in the mock this replaces.
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

    const geometry = buildCircuit({ gate: track.gate, targetLapM });
    this.points = geometry.points;
    this.kappa = geometry.kappa;
    this.ds = geometry.ds;
    this.lapLengthM = geometry.lapLengthM;
    this.frame = geometry.frame;

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
    this.previousSpeedMs = this.speedAt(this.distanceM);
  }

  /** Standard normal, Box-Muller over the seeded uniform stream. */
  gaussian() {
    const u = Math.max(this.random(), Number.EPSILON);
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * this.random());
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

    this.distanceM += this.speedAt(this.distanceM) * dt;
    this.lapMs += dtMs;

    if (this.distanceM >= this.lapLengthM) {
      this.distanceM -= this.lapLengthM;

      // Lap 0 is the out-lap, so it produces no lap time — the first crossing
      // starts the clock, it does not stop anything.
      if (this.lap > 0) {
        this.completedLapMs.push(Math.round(this.lapMs));
      }

      this.lap += 1;
      this.lapMs = 0;
      // `previousSpeedMs` is not updated until the end of this tick, so it still
      // holds the speed the car crossed the line at — the anchor the new
      // profile has to start from.
      this.speed = this.blendIntoNextLap(this.previousSpeedMs);
    }

    const { i0, i1, f } = this.indexAt(this.distanceM);
    const p0 = this.points[i0];
    const p1 = this.points[i1];

    const speedMs = this.speedAt(this.distanceM);
    const speedKmh = speedMs * 3.6;
    const kappa = this.kappa[i0] + (this.kappa[i1] - this.kappa[i0]) * f;

    // Longitudinal g from the actual change in speed, so a braking zone in the
    // profile is a braking zone in the g trace — they cannot disagree.
    const gLon = (speedMs - this.previousSpeedMs) / dt / G;
    this.previousSpeedMs = speedMs;
    this.topSpeedKmh = Math.max(this.topSpeedKmh, speedKmh);

    // Interpolate in the local metric frame and add noise there, then project
    // once. Adding noise in degrees would stretch it east-west.
    const x = p0.x + (p1.x - p0.x) * f + this.gaussian() * this.gpsNoiseM;
    const y = p0.y + (p1.y - p0.y) * f + this.gaussian() * this.gpsNoiseM;
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
