/**
 * The `GET /tracks/:track/map` contract, mirrored from
 * `apps/api/src/tracks/track-map/dto/track-map-response.dto.ts`.
 *
 * Duplicated rather than imported, as `analysis.model.ts` and
 * `live-telemetry.model.ts` already are: the frontend is a separate pnpm
 * project with no path into the Nest monorepo. Drift shows up as a field
 * reading `undefined`, not as bad data — but keep the two in step.
 */

export interface TrackMapCircuitProperties {
  role: 'circuit';
  lengthM: number;
  widthM: number;
}

export interface TrackMapCornerProperties {
  role: 'corner';
  name: string;
}

/**
 * A union of two full feature shapes, not one shape with a union-typed
 * `properties` — the latter makes `Extract<TrackMapFeature, {properties:
 * {role:'circuit'}}>` resolve to `never`, since `Extract` distributes over
 * union *members* of its first argument rather than narrowing a field inside
 * a single type.
 */
export type TrackMapFeature =
  | {
      type: 'Feature';
      properties: TrackMapCircuitProperties;
      geometry: { type: 'LineString'; coordinates: [number, number][] };
    }
  | {
      type: 'Feature';
      properties: TrackMapCornerProperties;
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

export interface TrackMapResponse {
  status: 'ready' | 'pending' | 'unavailable';
  /**
   * The circuit's human name. Present on every status — the server resolved
   * the opaque device track string to a row to answer at all, so it can
   * always say what that row is called.
   */
  trackName: string;
  map?: TrackMapGeoJson;
  bbox?: TrackMapBbox;
  centrelineLengthM?: number;
  attribution?: string;
  osmDataTimestamp?: string;
  failureReason?: string;
}

/**
 * The two halves of `TrackMapFeature`, narrowed.
 *
 * They live beside the union rather than in the components that draw it: both
 * canvas views need the same narrowing, and `Extract` against a role literal
 * is exactly the shape the union above was built for.
 */
export const isCircuit = (
  f: TrackMapFeature,
): f is Extract<TrackMapFeature, { properties: { role: 'circuit' } }> =>
  f.properties.role === 'circuit';

export const isCorner = (
  f: TrackMapFeature,
): f is Extract<TrackMapFeature, { properties: { role: 'corner' } }> =>
  f.properties.role === 'corner';
