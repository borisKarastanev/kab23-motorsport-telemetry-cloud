/**
 * Geometry comes from `analysis/geo`, not a fourth private copy of it.
 *
 * An earlier revision duplicated `METERS_PER_DEG_LAT`, `metersPerDegLon` and
 * `distanceM` here, arguing that importing back would be a module cycle. It is
 * not: `analysis/geo.ts` imports nothing at all, so this is a leaf edge, and
 * nothing under `tracks/` is reachable from it. The projection agreeing with
 * the analysis pass by construction is the whole point — a racing line and the
 * circuit drawn under it must not be projected by two constants that can drift.
 */
import { distanceM, localFrame } from '../../analysis/geo';
import { round } from '../../analysis/sample-math';
import {
  BuildOutcome,
  OverpassResponse,
  OverpassWay,
  TrackMapFeature,
} from './track-map.types';

/** Shortest distance from a point to the segment `a`–`b`, in metres. */
function pointToSegmentM(
  p: { lat: number; lon: number },
  a: { lat: number; lon: number },
  b: { lat: number; lon: number },
): number {
  const { toLocal } = localFrame(a.lat, a.lon);
  const P = toLocal(p.lat, p.lon);
  const B = toLocal(b.lat, b.lon);

  if (B.x === 0 && B.y === 0) {
    return Math.hypot(P.x, P.y);
  }

  const t = Math.max(
    0,
    Math.min(1, (P.x * B.x + P.y * B.y) / (B.x * B.x + B.y * B.y)),
  );
  return Math.hypot(P.x - t * B.x, P.y - t * B.y);
}

// --- Tunables --------------------------------------------------------------

/** How far apart a ring's two ends may be and still count as "closed". */
const MAX_CLOSURE_GAP_M = 25;
/** Below this a "circuit" is almost certainly a mis-stitched fragment. */
const MIN_CIRCUIT_LENGTH_M = 500;
/** Above this it is more likely two circuits merged than one real one. */
const MAX_CIRCUIT_LENGTH_M = 25_000;
/**
 * How far the seeded S/F gate's midpoint may sit from the stitched ring.
 *
 * The real guard: a closed, plausibly-sized ring in roughly the right place
 * could still be the wrong feature (a driving-school loop, a car park ring
 * road) if this were skipped. Validated at ~12.5 m for Serres's actual gate.
 */
const MAX_GATE_DISTANCE_M = 50;
/** No `width` tag on any contributing way — Serres carries one on all 32. */
const DEFAULT_WIDTH_M = 12;
/** ~11 cm at this latitude; visual overlay precision, not survey precision. */
const COORD_DECIMALS = 6;

export interface TrackMapGate {
  lat1: number;
  lon1: number;
  lat2: number;
  lon2: number;
}

interface Way {
  id: number;
  nodeIds: number[];
  points: { lat: number; lon: number }[];
  tags: Record<string, string>;
}

/**
 * Stitches Overpass's `highway=raceway` ways for one venue into a circuit
 * outline, or explains why it could not.
 *
 * A venue's raceway ways are a graph, not a list: `183478998` and its
 * neighbour end where the next one begins, sharing an OSM node id, and that
 * shared id is the only thing connecting them — there is no "this is the
 * circuit" tag anywhere in the data. So: filter obvious non-circuit ways
 * (the kart track, the pit lane), connect the rest by shared endpoint,
 * and **reject rather than guess** if the result does not close, is not a
 * plausible length, or does not sit under the track's own surveyed
 * start/finish gate. See the class-level rationale in `TrackMap` for why
 * `unavailable` is a first-class answer here, not a fallback to something
 * invented.
 */
export function buildTrackMap(
  response: OverpassResponse,
  gate: TrackMapGate,
): BuildOutcome {
  const ways = usableWays(response.elements);
  if (!ways.length) {
    return { outcome: 'rejected', reason: 'no-raceway-ways' };
  }

  const component = largestConnectedComponent(ways);
  const chain = walk(component);

  if (chain.points.length < 3) {
    return { outcome: 'rejected', reason: 'could-not-stitch-a-ring' };
  }

  const gap = distanceM(
    chain.points[0].lat,
    chain.points[0].lon,
    chain.points[chain.points.length - 1].lat,
    chain.points[chain.points.length - 1].lon,
  );
  if (gap > MAX_CLOSURE_GAP_M) {
    return {
      outcome: 'rejected',
      reason: `ring-not-closed (${Math.round(gap)}m gap)`,
    };
  }

  const lengthM = polylineLengthM(chain.points);
  if (lengthM < MIN_CIRCUIT_LENGTH_M || lengthM > MAX_CIRCUIT_LENGTH_M) {
    return {
      outcome: 'rejected',
      reason: `implausible-length (${Math.round(lengthM)}m)`,
    };
  }

  const gateMidLat = (gate.lat1 + gate.lat2) / 2;
  const gateMidLon = (gate.lon1 + gate.lon2) / 2;
  const gateDistanceM = minDistanceToPolyline(
    { lat: gateMidLat, lon: gateMidLon },
    chain.points,
  );
  if (gateDistanceM > MAX_GATE_DISTANCE_M) {
    return {
      outcome: 'rejected',
      reason: `gate-not-on-ring (${Math.round(gateDistanceM)}m away)`,
    };
  }

  const geojson = {
    type: 'FeatureCollection' as const,
    features: [
      circuitFeature(chain.points, lengthM, widthOf(chain.ways)),
      ...cornerFeatures(chain.ways),
    ],
  };

  return {
    outcome: 'built',
    geojson,
    bbox: bboxOf(chain.points),
    centrelineLengthM: lengthM,
    osmDataTimestamp: parseTimestamp(response.osm3s?.timestamp_osm_base),
  };
}

// ---------------------------------------------------------------------------
// Filtering
// ---------------------------------------------------------------------------

function usableWays(elements: OverpassWay[]): Way[] {
  return elements
    .filter((e) => e.type === 'way' && e.tags?.highway === 'raceway')
    .filter((e) => !isExcluded(e.tags))
    .filter((e) => e.nodes.length >= 2 && e.geometry.length === e.nodes.length)
    .map((e) => ({
      id: e.id,
      nodeIds: e.nodes,
      points: e.geometry.map((g) => ({ lat: g.lat, lon: g.lon })),
      tags: e.tags ?? {},
    }));
}

/**
 * Karting and the pit lane both carry `highway=raceway` at Serres, sharing
 * the site with the main circuit — without this a "circuit" comes out as the
 * 1.2 km kart track or gains a 462 m pit-lane spur.
 */
function isExcluded(tags: Record<string, string> = {}): boolean {
  return tags.sport === 'karting' || tags.raceway === 'pit_lane';
}

// ---------------------------------------------------------------------------
// Stitching
// ---------------------------------------------------------------------------

/**
 * Union-find over ways sharing an endpoint node, so a venue with more than
 * one raceway feature (Serres has the kart track's leftovers and stray
 * unconnected fragments even after filtering) does not have its longest
 * genuine ring diluted by unrelated pieces sitting in the same query radius.
 */
function largestConnectedComponent(ways: Way[]): Way[] {
  const parent = new Map<number, number>();
  const find = (id: number): number => {
    let root = id;
    while (parent.get(root) !== undefined && parent.get(root) !== root) {
      root = parent.get(root)!;
    }
    parent.set(id, root);
    return root;
  };
  const union = (a: number, b: number) => {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) {
      parent.set(ra, rb);
    }
  };

  for (const way of ways) {
    parent.set(way.id, way.id);
  }

  const byEndpoint = endpointIndex(ways);
  for (const wayIds of byEndpoint.values()) {
    for (let i = 1; i < wayIds.length; i++) {
      union(wayIds[0], wayIds[i]);
    }
  }

  const groups = new Map<number, Way[]>();
  for (const way of ways) {
    const root = find(way.id);
    const group = groups.get(root);
    if (group) {
      group.push(way);
    } else {
      groups.set(root, [way]);
    }
  }

  let best: Way[] = [];
  let bestLength = -1;
  for (const group of groups.values()) {
    const length = group.reduce(
      (sum, way) => sum + polylineLengthM(way.points),
      0,
    );
    if (length > bestLength) {
      best = group;
      bestLength = length;
    }
  }

  return best;
}

/**
 * Which ways meet at each endpoint node.
 *
 * The one non-obvious fact about OSM raceway geometry this module leans on:
 * ways connect *through shared endpoint node ids*, not through coincident
 * coordinates. Both the connectivity pass and the walk need the same index, so
 * they read it from here rather than each building their own — they have to
 * agree on what "connected" means or they disagree about the same ring.
 */
function endpointIndex(ways: Way[]): Map<number, number[]> {
  const byEndpoint = new Map<number, number[]>();

  for (const way of ways) {
    for (const nodeId of [
      way.nodeIds[0],
      way.nodeIds[way.nodeIds.length - 1],
    ]) {
      const bucket = byEndpoint.get(nodeId);
      if (bucket) {
        bucket.push(way.id);
      } else {
        byEndpoint.set(nodeId, [way.id]);
      }
    }
  }

  return byEndpoint;
}

/**
 * Greedily walks a connected set of ways into one ordered polyline.
 *
 * Correct for the case this exists to handle — a real circuit's raceway ways
 * form a simple ring, degree 2 at every join — and validated against it at
 * three tracks. A component with an actual branch (a node shared by three
 * ways) still produces *a* path rather than failing outright; the closure,
 * length and gate checks around the call site are what catch a walk that
 * picked the wrong branch.
 */
function walk(ways: Way[]): {
  points: { lat: number; lon: number }[];
  ways: Way[];
} {
  if (!ways.length) {
    return { points: [], ways: [] };
  }

  const byId = new Map(ways.map((w) => [w.id, w]));
  const byEndpoint = endpointIndex(ways);

  const used = new Set<number>();
  const first = ways[0];
  used.add(first.id);
  const points = [...first.points];
  const orderedWays = [first];
  let tailNode = first.nodeIds[first.nodeIds.length - 1];

  while (true) {
    const candidates = (byEndpoint.get(tailNode) ?? []).filter(
      (id) => !used.has(id),
    );
    if (!candidates.length) {
      break;
    }

    const next = byId.get(candidates[0])!;
    used.add(next.id);
    orderedWays.push(next);

    const forward = next.nodeIds[0] === tailNode;
    const segment = forward ? next.points : [...next.points].reverse();
    // The shared node is already the last point of `points` — drop its
    // duplicate at the front of the next segment, or every join doubles up.
    points.push(...segment.slice(1));
    tailNode = forward
      ? next.nodeIds[next.nodeIds.length - 1]
      : next.nodeIds[0];
  }

  return { points, ways: orderedWays };
}

function polylineLengthM(points: { lat: number; lon: number }[]): number {
  let total = 0;
  for (let i = 1; i < points.length; i++) {
    total += distanceM(
      points[i - 1].lat,
      points[i - 1].lon,
      points[i].lat,
      points[i].lon,
    );
  }
  return total;
}

function minDistanceToPolyline(
  point: { lat: number; lon: number },
  polyline: { lat: number; lon: number }[],
): number {
  let min = Infinity;
  for (let i = 1; i < polyline.length; i++) {
    min = Math.min(min, pointToSegmentM(point, polyline[i - 1], polyline[i]));
  }
  return min;
}

// ---------------------------------------------------------------------------
// GeoJSON assembly
// ---------------------------------------------------------------------------

function toCoords(points: { lat: number; lon: number }[]): [number, number][] {
  return points.map((p) => [
    round(p.lon, COORD_DECIMALS),
    round(p.lat, COORD_DECIMALS),
  ]);
}

function circuitFeature(
  points: { lat: number; lon: number }[],
  lengthM: number,
  widthM: number,
): TrackMapFeature {
  return {
    type: 'Feature',
    properties: { role: 'circuit', lengthM: Math.round(lengthM), widthM },
    geometry: { type: 'LineString', coordinates: toCoords(points) },
  };
}

/**
 * One feature per named contributing way, sorted the way a person reads them.
 *
 * Empty when the ring is a single way — Kaloyanovo's circuit is one closed
 * way named "Дракон", and without this guard that name would double as a
 * "corner" feature, drawing a marker labelled with the circuit's own name at
 * an arbitrary point along it. A corner is only a meaningful concept once a
 * ring is built from more than one segment; a single-way ring's name
 * describes the whole track, not a piece of it.
 */
function cornerFeatures(ways: Way[]): TrackMapFeature[] {
  if (ways.length <= 1) {
    return [];
  }

  return (
    ways
      .filter((way) => way.tags.name)
      // `numeric` is what puts K2 before K10; a plain sort puts K10 second.
      // It also orders the non-ASCII names this feature actually meets —
      // Kaloyanovo's ways are Cyrillic — which a codepoint comparison does not.
      .sort((a, b) =>
        a.tags.name.localeCompare(b.tags.name, undefined, { numeric: true }),
      )
      .map((way) => ({
        type: 'Feature' as const,
        properties: { role: 'corner' as const, name: way.tags.name },
        geometry: {
          type: 'LineString' as const,
          coordinates: toCoords(way.points),
        },
      }))
  );
}

function widthOf(ways: Way[]): number {
  const widths = ways
    .map((way) => Number(way.tags.width))
    .filter((w) => Number.isFinite(w) && w > 0)
    .sort((a, b) => a - b);

  if (!widths.length) {
    return DEFAULT_WIDTH_M;
  }

  return widths[Math.floor(widths.length / 2)];
}

function bboxOf(points: { lat: number; lon: number }[]) {
  let minLat = Infinity;
  let minLon = Infinity;
  let maxLat = -Infinity;
  let maxLon = -Infinity;

  for (const p of points) {
    minLat = Math.min(minLat, p.lat);
    minLon = Math.min(minLon, p.lon);
    maxLat = Math.max(maxLat, p.lat);
    maxLon = Math.max(maxLon, p.lon);
  }

  return { minLat, minLon, maxLat, maxLon };
}

function parseTimestamp(value: string | undefined): Date | null {
  if (!value) {
    return null;
  }
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}
