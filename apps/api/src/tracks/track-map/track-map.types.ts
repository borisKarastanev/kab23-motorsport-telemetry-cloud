/**
 * Overpass's `out geom;` shape, for one `highway=raceway` way.
 *
 * `nodes` (the way's member node ids) and `geometry` (their coordinates, in
 * the same order) are both present and share an index — that pairing is what
 * lets `track-map.builder.ts` stitch ways sharing an endpoint node into one
 * ring without a second request to resolve node ids to coordinates.
 */
export interface OverpassWay {
  type: 'way';
  id: number;
  nodes: number[];
  geometry: { lat: number; lon: number }[];
  tags?: Record<string, string>;
}

export interface OverpassResponse {
  version: number;
  generator: string;
  /** `timestamp_osm_base` dates the *data*, not the fetch. */
  osm3s: { timestamp_osm_base: string; copyright: string };
  elements: OverpassWay[];
}

export type TrackMapFeature =
  | {
      type: 'Feature';
      properties: { role: 'circuit'; lengthM: number; widthM: number };
      geometry: { type: 'LineString'; coordinates: [number, number][] };
    }
  | {
      type: 'Feature';
      properties: { role: 'corner'; name: string };
      geometry: { type: 'LineString'; coordinates: [number, number][] };
    };

export interface TrackMapGeoJson {
  type: 'FeatureCollection';
  features: TrackMapFeature[];
}

export interface TrackMapBbox {
  minLat: number;
  minLon: number;
  maxLat: number;
  maxLon: number;
}

/**
 * What `track-map.builder.ts` hands back — never throws, always one of these.
 *
 * Discriminated on a string literal (`outcome`), not a boolean: this repo's
 * `strictNullChecks: false` (tsconfig.json) silently drops control-flow
 * narrowing for a `true | false` discriminant specifically — `if (x.ok)
 * return;` fails to narrow the remainder to the other branch, with no
 * compiler warning that the narrowing did not happen. A string-literal
 * discriminant narrows correctly under the same setting, which is also why
 * `AnalysisSkipReason` and `TrackMapStatus` are strings rather than booleans.
 */
export type BuildOutcome =
  | {
      outcome: 'built';
      geojson: TrackMapGeoJson;
      bbox: TrackMapBbox;
      centrelineLengthM: number;
      osmDataTimestamp: Date | null;
    }
  | { outcome: 'rejected'; reason: string };

/**
 * "A fetch is underway and outran the caller's deadline."
 *
 * A service-level sentinel, never a persisted status: `unavailable` is a row
 * with a cooldown, this is the absence of a row yet. It lives here rather than
 * on the service so the DTO can map it without the wire-shape layer importing
 * the service layer — and so the DTO's spec does not drag `TrackMapService`'s
 * whole dependency graph in to test a pure mapping function.
 */
export const PENDING = 'pending' as const;
