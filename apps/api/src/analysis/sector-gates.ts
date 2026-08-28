import { Gate, LapPoint } from './analysis.types';
import { distanceM, localFrame } from './geo';
import { crossGates, DEFAULT_SECTOR_COUNT } from './sectors';

/**
 * Where a session's sector gates come from, and how to get real ones when
 * nobody surveyed them.
 *
 * Resolution order, first hit wins — see `resolveSectorGates`:
 *
 * 1. Surveyed (`Track.sectorGates`) — authoritative, this module never
 *    touches it.
 * 2. Already derived and persisted (`Track.derivedSectorGates`) — a plain
 *    read, this module never touches it either.
 * 3. Derived from the OSM centreline (`track_maps`), when one is ready.
 * 4. Derived from the session's own best lap, when the track map is not
 *    ready or does not exist.
 * 5. Nothing — the caller falls back to `sectorTimes`'s distance fractions
 *    and the session is stamped legacy.
 *
 * Steps 1–2 (`knownSectorGates`) and steps 3–4 (`deriveSectorGates`) are
 * separately callable, because only the second half needs a track map — see
 * `knownSectorGates`.
 *
 * **Reject rather than guess**, the rule this codebase already applies to
 * track maps: a candidate gate set is only handed back if every gate is
 * crossed exactly once by the reference lap, in order, and the resulting
 * boundary distances land near an equal fraction of that lap's length. Reused
 * wholesale from `crossGates` rather than a second crossing test.
 */

/** How far a resolved gate's crossing distance may sit from `lapDistance/N`. */
const SANE_BAND_FACTOR = 0.4;

/** How far into the reference lap to sample a point for direction detection. */
const DIRECTION_PROBE_M = 50;

export type SectorGatesSource = 'surveyed' | 'centreline' | 'reference-lap';

/** What steps 3/4 hand back for `Track.derivedSectorGates` to persist. */
export interface DerivedSectorGates {
  gates: Gate[];
  source: Extract<SectorGatesSource, 'centreline' | 'reference-lap'>;
}

export interface SectorGatesResolution {
  gates: Gate[];
  source: SectorGatesSource;
  /**
   * Present only when this call derived a brand-new set — the caller persists
   * it to `Track.derivedSectorGates` so every later session at this track
   * reads it back as a plain value instead of re-deriving.
   */
  newlyDerived?: DerivedSectorGates;
}

/** A point with a cumulative distance along whatever path it belongs to. */
interface OffsetPoint {
  lat: number;
  lon: number;
  distM: number;
}

/** What steps 1 and 2 read — nothing derived, nothing fetched. */
export interface KnownSectorGatesInput {
  surveyedGates?: Gate[] | null;
  persistedDerivedGates?: DerivedSectorGates | null;
}

/** What steps 3 and 4 need on top of that. */
export interface DeriveSectorGatesInput {
  sfGate: Gate;
  /** The circuit centreline, in driving order or not — direction is detected. */
  ring?: { lat: number; lon: number }[];
  centrelineLengthM?: number;
  /** This session's best lap, the only thing steps 3/4 can derive from. */
  referenceLap: { points: LapPoint[]; distanceM: number } | null;
  sectorCount?: number;
}

/**
 * Steps 1 and 2 alone — a gate set somebody already knows about.
 *
 * Split out from `resolveSectorGates` so a caller can answer "are the gates
 * already known?" *before* paying for anything the later steps need. That is
 * not a micro-optimisation: `AnalysisService` gets its `ring` from
 * `TracksService.getTrackMap`, which on a cold or stale track races an outbound
 * Overpass fetch against `TRACK_MAP_FETCH_DEADLINE_MS`, so resolving in one
 * call put up to eight seconds of third-party latency in front of a result that
 * was already sitting on the track row.
 */
export function knownSectorGates(
  input: KnownSectorGatesInput,
): SectorGatesResolution | null {
  if (input.surveyedGates?.length) {
    return { gates: input.surveyedGates, source: 'surveyed' };
  }

  if (input.persistedDerivedGates?.gates.length) {
    return {
      gates: input.persistedDerivedGates.gates,
      source: input.persistedDerivedGates.source,
    };
  }

  return null;
}

/** Steps 3 and 4 alone — derive a brand-new set, or decline to. */
export function deriveSectorGates(
  input: DeriveSectorGatesInput,
): SectorGatesResolution | null {
  const sectorCount = input.sectorCount ?? DEFAULT_SECTOR_COUNT;
  const referenceLap = input.referenceLap;
  if (!referenceLap || referenceLap.points.length < 3 || sectorCount < 2) {
    return null;
  }

  if (input.ring && input.ring.length >= 3 && input.centrelineLengthM) {
    const gates = deriveFromCentreline(
      input.ring,
      input.centrelineLengthM,
      input.sfGate,
      referenceLap.points,
      sectorCount,
    );
    if (gates) {
      return {
        gates,
        source: 'centreline',
        newlyDerived: { gates, source: 'centreline' },
      };
    }
  }

  const gates = deriveFromLap(referenceLap.points, input.sfGate, sectorCount);
  if (gates) {
    return {
      gates,
      source: 'reference-lap',
      newlyDerived: { gates, source: 'reference-lap' },
    };
  }

  return null;
}

/** The whole ladder, steps 1–4, first hit wins. */
export function resolveSectorGates(
  input: KnownSectorGatesInput & DeriveSectorGatesInput,
): SectorGatesResolution | null {
  return knownSectorGates(input) ?? deriveSectorGates(input);
}

// ---------------------------------------------------------------------------
// Step 3 — derive from the OSM centreline
// ---------------------------------------------------------------------------

function deriveFromCentreline(
  ring: { lat: number; lon: number }[],
  centrelineLengthM: number,
  sfGate: Gate,
  referenceLapPoints: LapPoint[],
  sectorCount: number,
): Gate[] | null {
  const sfMid = midpoint(sfGate);
  const sfIndex = nearestIndex(ring, sfMid);
  const direction = detectDirection(ring, sfIndex, referenceLapPoints);
  const directedRing = buildDirectedRing(ring, sfIndex, direction);
  const halfWidthM = gateHalfWidthM(sfGate);

  const candidate = buildInteriorGates(
    directedRing,
    centrelineLengthM,
    halfWidthM,
    sectorCount,
  );

  const lapDistanceM = referenceLapPoints[referenceLapPoints.length - 1].distM;
  return isValidCandidate(
    referenceLapPoints,
    candidate,
    lapDistanceM,
    sectorCount,
  )
    ? candidate
    : null;
}

/** The ring index whose point sits nearest the given point. */
function nearestIndex(
  ring: { lat: number; lon: number }[],
  point: { lat: number; lon: number },
): number {
  let bestIndex = 0;
  let bestM = Infinity;

  for (let i = 0; i < ring.length; i++) {
    const d = distanceM(point.lat, point.lon, ring[i].lat, ring[i].lon);
    if (d < bestM) {
      bestM = d;
      bestIndex = i;
    }
  }

  return bestIndex;
}

/**
 * Whether walking the ring by increasing or decreasing index moves in the
 * direction the car actually drove.
 *
 * The ring's own winding is an artefact of how OSM's ways happened to be
 * stitched; the car's is not. A point a short, fixed distance into the
 * reference lap is matched to its nearest ring index, and whichever winding
 * gets from the S/F index to that index in fewer steps is the one the car
 * drove.
 */
function detectDirection(
  ring: { lat: number; lon: number }[],
  sfIndex: number,
  referenceLapPoints: LapPoint[],
): 1 | -1 {
  const probe =
    referenceLapPoints.find((p) => p.distM >= DIRECTION_PROBE_M) ??
    referenceLapPoints[referenceLapPoints.length - 1];
  const probeIndex = nearestIndex(ring, probe);

  const n = ring.length;
  const forwardSteps = (probeIndex - sfIndex + n) % n;
  const backwardSteps = (sfIndex - probeIndex + n) % n;

  return forwardSteps <= backwardSteps ? 1 : -1;
}

/**
 * The ring re-walked from the S/F-nearest point, in driving direction, with a
 * cumulative distance at every point — offset 0 at the start, closing back on
 * itself at the end.
 */
function buildDirectedRing(
  ring: { lat: number; lon: number }[],
  startIndex: number,
  direction: 1 | -1,
): OffsetPoint[] {
  const n = ring.length;
  const ordered: { lat: number; lon: number }[] = [];
  for (let i = 0; i < n; i++) {
    const idx =
      direction === 1 ? (startIndex + i) % n : (startIndex - i + n) % n;
    ordered.push(ring[idx]);
  }
  ordered.push(ordered[0]);

  const points: OffsetPoint[] = [{ ...ordered[0], distM: 0 }];
  for (let i = 1; i < ordered.length; i++) {
    const prev = points[i - 1];
    points.push({
      ...ordered[i],
      distM:
        prev.distM +
        distanceM(prev.lat, prev.lon, ordered[i].lat, ordered[i].lon),
    });
  }

  return points;
}

// ---------------------------------------------------------------------------
// Step 4 — derive from the reference lap's own trace
// ---------------------------------------------------------------------------

function deriveFromLap(
  points: LapPoint[],
  sfGate: Gate,
  sectorCount: number,
): Gate[] | null {
  const lapDistanceM = points[points.length - 1].distM;
  if (lapDistanceM <= 0) {
    return null;
  }

  const halfWidthM = gateHalfWidthM(sfGate);
  const candidate = buildInteriorGates(
    points,
    lapDistanceM,
    halfWidthM,
    sectorCount,
  );

  return isValidCandidate(points, candidate, lapDistanceM, sectorCount)
    ? candidate
    : null;
}

// ---------------------------------------------------------------------------
// Shared construction and validation
// ---------------------------------------------------------------------------

/**
 * `sectorCount - 1` interior gates at `k/N` of `totalM` along `path`, each
 * perpendicular to the path's local heading there, spanning `halfWidthM` on
 * each side.
 *
 * The same construction whether `path` is the OSM centreline (walked from the
 * S/F point, in driving direction) or a lap's own trace (already in driving
 * order) — both are just an ordered, distance-indexed polyline.
 */
function buildInteriorGates(
  path: OffsetPoint[],
  totalM: number,
  halfWidthM: number,
  sectorCount: number,
): Gate[] {
  const gates: Gate[] = [];

  for (let k = 1; k < sectorCount; k++) {
    const targetM = (totalM * k) / sectorCount;
    const { center, a, b } = pointAtDistance(path, targetM, totalM);
    gates.push(perpendicularGateAt(a, b, center, halfWidthM));
  }

  return gates;
}

/** The point on `path` at `targetM`, wrapping into `[0, totalM)` first. */
function pointAtDistance<T extends OffsetPoint>(
  path: T[],
  targetM: number,
  totalM: number,
): { center: { lat: number; lon: number }; a: T; b: T } {
  const t = totalM > 0 ? ((targetM % totalM) + totalM) % totalM : 0;

  for (let i = 1; i < path.length; i++) {
    if (path[i].distM >= t) {
      const a = path[i - 1];
      const b = path[i];
      const span = b.distM - a.distM;
      const frac = span > 0 ? (t - a.distM) / span : 0;
      return {
        center: {
          lat: a.lat + frac * (b.lat - a.lat),
          lon: a.lon + frac * (b.lon - a.lon),
        },
        a,
        b,
      };
    }
  }

  const a = path[Math.max(path.length - 2, 0)];
  const b = path[path.length - 1];
  return { center: { lat: b.lat, lon: b.lon }, a, b };
}

/**
 * A gate perpendicular to the `a -> b` direction, centred on `center`.
 *
 * Built in a local metre frame rather than from a compass heading: the two
 * points already define a direction vector, and rotating it 90° and stepping
 * `halfWidthM` each way needs no trigonometric heading at all.
 */
function perpendicularGateAt(
  a: { lat: number; lon: number },
  b: { lat: number; lon: number },
  center: { lat: number; lon: number },
  halfWidthM: number,
): Gate {
  const { toLocal, toGeo } = localFrame(center.lat, center.lon);
  const A = toLocal(a.lat, a.lon);
  const B = toLocal(b.lat, b.lon);
  const dx = B.x - A.x;
  const dy = B.y - A.y;
  const len = Math.hypot(dx, dy) || 1;

  // Rotate the direction vector 90°.
  const ux = -dy / len;
  const uy = dx / len;

  const p1 = toGeo(ux * halfWidthM, uy * halfWidthM);
  const p2 = toGeo(-ux * halfWidthM, -uy * halfWidthM);
  return { lat1: p1.lat, lon1: p1.lon, lat2: p2.lat, lon2: p2.lon };
}

function gateHalfWidthM(gate: Gate): number {
  return distanceM(gate.lat1, gate.lon1, gate.lat2, gate.lon2) / 2;
}

function midpoint(gate: Gate): { lat: number; lon: number } {
  return { lat: (gate.lat1 + gate.lat2) / 2, lon: (gate.lon1 + gate.lon2) / 2 };
}

/**
 * A candidate is only handed back if the reference lap crosses every gate
 * exactly once, in order (`crossGates` already enforces both), *and* each
 * crossing's distance along the lap lands within `SANE_BAND_FACTOR` of the
 * fraction of the lap it is supposed to split at.
 *
 * The second check is what `crossGates` alone cannot catch: a degenerate gate
 * — one that happens to lie across the track somewhere nowhere near its
 * intended `k/N` point, but that the lap still crosses cleanly once — would
 * pass crossing validation and still be a nonsense split.
 */
function isValidCandidate(
  points: LapPoint[],
  gates: Gate[],
  lapDistanceM: number,
  sectorCount: number,
): boolean {
  const crossings = crossGates(points, gates);
  if (!crossings) {
    return false;
  }

  const idealStep = lapDistanceM / sectorCount;
  const band = idealStep * SANE_BAND_FACTOR;

  return crossings.every((crossing, i) => {
    const idealDistM = idealStep * (i + 1);
    return Math.abs(crossing.distM - idealDistM) <= band;
  });
}
