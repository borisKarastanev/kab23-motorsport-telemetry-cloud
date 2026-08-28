import { readyCircuit } from './track-map.geometry';
import { TrackMap, TrackMapStatus } from './entities/track-map.entity';
import { PENDING, TrackMapFeature } from './track-map.types';

const circuitFeature: TrackMapFeature = {
  type: 'Feature',
  properties: { role: 'circuit', lengthM: 3175, widthM: 10 },
  // GeoJSON order — [lon, lat], the transposition this module exists to undo.
  geometry: {
    type: 'LineString',
    coordinates: [
      [23.5, 41.1],
      [23.6, 41.2],
    ],
  },
};

const cornerFeature: TrackMapFeature = {
  type: 'Feature',
  properties: { role: 'corner', name: 'Turn 1' },
  geometry: { type: 'LineString', coordinates: [[23.55, 41.15]] },
};

const readyRow = (features: TrackMapFeature[]) =>
  new TrackMap({
    status: TrackMapStatus.READY,
    geojson: { type: 'FeatureCollection', features },
    centrelineLengthM: 3175,
  });

describe('readyCircuit', () => {
  it('returns the circuit ring in {lat, lon}, with its length', () => {
    // The corner feature is in the collection too, and must not be mistaken
    // for the centreline — picking `features[0]` would have worked here only
    // by luck of ordering.
    expect(readyCircuit(readyRow([cornerFeature, circuitFeature]))).toEqual({
      ring: [
        { lat: 41.1, lon: 23.5 },
        { lat: 41.2, lon: 23.6 },
      ],
      centrelineLengthM: 3175,
    });
  });

  it('has nothing to offer while a fetch is still running', () => {
    expect(readyCircuit(PENDING)).toBeUndefined();
  });

  it('has nothing to offer for a track OSM could not supply', () => {
    const row = new TrackMap({
      status: TrackMapStatus.UNAVAILABLE,
      failureReason: 'gate-not-on-ring',
    });

    expect(readyCircuit(row)).toBeUndefined();
  });

  it('has nothing to offer for a ready row carrying no circuit feature', () => {
    // Not a state the builder produces — it only persists `ready` with a
    // stitched ring — but the caller wants a ring or nothing, and "ready" is
    // not on its own a promise that one is there.
    expect(readyCircuit(readyRow([cornerFeature]))).toBeUndefined();
    expect(readyCircuit(readyRow([]))).toBeUndefined();
  });
});
