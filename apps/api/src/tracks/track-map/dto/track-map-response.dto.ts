import { TrackMap, TrackMapStatus } from '../entities/track-map.entity';
import { PENDING, TrackMapBbox, TrackMapGeoJson } from '../track-map.types';

export class TrackMapResponseDto {
  status: 'ready' | 'pending' | 'unavailable';
  /**
   * The circuit's human name, e.g. "Kaloyanovo".
   *
   * Carried on *every* status, including `unavailable`: the caller asked with
   * whatever opaque string its own on-car database calls the track, and this
   * endpoint has already resolved that to a row. Answering the name here is
   * what stops the browser re-fetching `GET /tracks` and re-implementing
   * `TracksService.resolve`'s slug-or-`deviceTrackIds` match — a rule that
   * cannot be shared across the project boundary and so would drift.
   */
  trackName: string;
  map?: TrackMapGeoJson;
  bbox?: TrackMapBbox;
  centrelineLengthM?: number;
  attribution?: string;
  osmDataTimestamp?: Date;
  /** Only on `unavailable` — never surfaced when `map` is present. */
  failureReason?: string;
}

/**
 * `TrackMapService.get` returns an entity (or the `PENDING` sentinel);
 * `TracksController` returns a client-shaped DTO. Kept as one small function
 * rather than a class-transformer `@Expose` scheme because the entity's
 * shape and the wire shape genuinely differ — `PENDING` isn't a database
 * row, and a `ready` response has no `failureReason` to accidentally leak.
 */
export function toTrackMapResponseDto(
  result: TrackMap | typeof PENDING,
  trackName: string,
): TrackMapResponseDto {
  if (result === PENDING) {
    return { status: 'pending', trackName };
  }

  if (result.status === TrackMapStatus.UNAVAILABLE) {
    return {
      status: 'unavailable',
      trackName,
      failureReason: result.failureReason,
    };
  }

  return {
    status: 'ready',
    trackName,
    map: result.geojson,
    bbox:
      result.bboxMinLat != null
        ? {
            minLat: result.bboxMinLat,
            minLon: result.bboxMinLon!,
            maxLat: result.bboxMaxLat!,
            maxLon: result.bboxMaxLon!,
          }
        : undefined,
    centrelineLengthM: result.centrelineLengthM,
    attribution: result.attribution,
    osmDataTimestamp: result.osmDataTimestamp,
  };
}
