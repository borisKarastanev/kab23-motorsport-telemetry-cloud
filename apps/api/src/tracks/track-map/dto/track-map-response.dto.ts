import { TrackMap, TrackMapStatus } from '../entities/track-map.entity';
import { PENDING, TrackMapBbox, TrackMapGeoJson } from '../track-map.types';

export class TrackMapResponseDto {
  status: 'ready' | 'pending' | 'unavailable';
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
): TrackMapResponseDto {
  if (result === PENDING) {
    return { status: 'pending' };
  }

  if (result.status === TrackMapStatus.UNAVAILABLE) {
    return { status: 'unavailable', failureReason: result.failureReason };
  }

  return {
    status: 'ready',
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
