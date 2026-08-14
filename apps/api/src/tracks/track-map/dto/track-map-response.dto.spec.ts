import { toTrackMapResponseDto } from './track-map-response.dto';
import { TrackMap, TrackMapStatus } from '../entities/track-map.entity';
import { PENDING } from '../track-map.types';

describe('toTrackMapResponseDto', () => {
  it('maps PENDING to a bare pending status', () => {
    expect(toTrackMapResponseDto(PENDING, 'Kaloyanovo')).toEqual({
      status: 'pending',
      trackName: 'Kaloyanovo',
    });
  });

  it('maps an unavailable row to its failure reason, and nothing else', () => {
    const row = new TrackMap({
      status: TrackMapStatus.UNAVAILABLE,
      failureReason: 'no-raceway-ways',
      fetchedAt: new Date(),
    });

    // The name rides along even here: the racing line still renders, and the
    // browser has no other way to turn its opaque track string into a name.
    expect(toTrackMapResponseDto(row, 'Kaloyanovo')).toEqual({
      status: 'unavailable',
      trackName: 'Kaloyanovo',
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

    expect(toTrackMapResponseDto(row, 'Serres Automotive Park')).toEqual({
      status: 'ready',
      trackName: 'Serres Automotive Park',
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

    expect(
      toTrackMapResponseDto(row, 'Kaloyanovo').failureReason,
    ).toBeUndefined();
  });
});
