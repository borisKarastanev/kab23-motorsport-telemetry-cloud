import { toTrackMapResponseDto } from './track-map-response.dto';
import { TrackMap, TrackMapStatus } from '../entities/track-map.entity';
import { PENDING } from '../track-map.types';

describe('toTrackMapResponseDto', () => {
  it('maps PENDING to a bare pending status', () => {
    expect(toTrackMapResponseDto(PENDING)).toEqual({ status: 'pending' });
  });

  it('maps an unavailable row to its failure reason, and nothing else', () => {
    const row = new TrackMap({
      status: TrackMapStatus.UNAVAILABLE,
      failureReason: 'no-raceway-ways',
      fetchedAt: new Date(),
    });

    expect(toTrackMapResponseDto(row)).toEqual({
      status: 'unavailable',
      failureReason: 'no-raceway-ways',
    });
  });

  it('maps a ready row to the map, bbox, and provenance fields', () => {
    const osmDataTimestamp = new Date('2026-08-12T12:00:00Z');
    const row = new TrackMap({
      status: TrackMapStatus.READY,
      geojson: { type: 'FeatureCollection', features: [] },
      bboxMinLat: 41,
      bboxMinLon: 23,
      bboxMaxLat: 41.1,
      bboxMaxLon: 23.1,
      centrelineLengthM: 3175,
      attribution: 'Map data © OpenStreetMap contributors, ODbL 1.0',
      osmDataTimestamp,
      fetchedAt: new Date(),
    });

    expect(toTrackMapResponseDto(row)).toEqual({
      status: 'ready',
      map: { type: 'FeatureCollection', features: [] },
      bbox: { minLat: 41, minLon: 23, maxLat: 41.1, maxLon: 23.1 },
      centrelineLengthM: 3175,
      attribution: 'Map data © OpenStreetMap contributors, ODbL 1.0',
      osmDataTimestamp,
    });
  });

  it('never leaks a failureReason on a ready row', () => {
    const row = new TrackMap({
      status: TrackMapStatus.READY,
      geojson: { type: 'FeatureCollection', features: [] },
      fetchedAt: new Date(),
    });

    expect(toTrackMapResponseDto(row).failureReason).toBeUndefined();
  });
});
