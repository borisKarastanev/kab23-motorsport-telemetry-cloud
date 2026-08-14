import { readFileSync } from 'fs';
import { join } from 'path';
import { buildTrackMap } from './track-map.builder';
import { OverpassResponse, TrackMapFeature } from './track-map.types';

const isCircuit = (
  f: TrackMapFeature,
): f is Extract<TrackMapFeature, { properties: { role: 'circuit' } }> =>
  f.properties.role === 'circuit';

// Read rather than `import … from '*.json'`: the repo's tsconfig does not set
// `resolveJsonModule`, and these fixtures are the only files that would need it.
const serresOverpass = JSON.parse(
  readFileSync(join(__dirname, '__fixtures__/serres-overpass.json'), 'utf-8'),
);
const kaloyanovoOverpass = JSON.parse(
  readFileSync(
    join(__dirname, '__fixtures__/kaloyanovo-overpass.json'),
    'utf-8',
  ),
);

// The Serres seed row's own S/F gate (apps/api/src/tracks/tracks.seed.ts).
const SERRES_GATE = {
  lat1: 41.0732367,
  lon1: 23.5178661,
  lat2: 41.0730709,
  lon2: 23.5176703,
};

const response = serresOverpass as unknown as OverpassResponse;

describe('buildTrackMap', () => {
  describe('against the real captured Serres response', () => {
    it('stitches the 32 circuit ways into one closed ring, excluding the kart track and pit lane', () => {
      const result = buildTrackMap(response, SERRES_GATE);
      expect(result.outcome).toBe('built');
      if (result.outcome !== 'built') return;

      // 3175 m measured live against Serres's official 3.186 km; a wide
      // tolerance guards against small floating-point drift in the projection,
      // not against a wrong answer.
      expect(result.centrelineLengthM).toBeGreaterThan(3000);
      expect(result.centrelineLengthM).toBeLessThan(3300);

      const circuit = result.geojson.features.find(isCircuit);
      expect(circuit).toBeDefined();
      if (!circuit) return;

      // The kart track (1215 m) and pit lane (462 m) would both fail this
      // bound if they leaked into the stitched ring.
      expect(circuit.properties.widthM).toBe(12);

      const coords = circuit.geometry.coordinates;
      expect(coords[0]).toEqual(coords[coords.length - 1]);
    });

    it('names all 16 corners, K1 through K16, in natural order', () => {
      const result = buildTrackMap(response, SERRES_GATE);
      expect(result.outcome).toBe('built');
      if (result.outcome !== 'built') return;

      const corners = result.geojson.features
        .filter((f) => f.properties.role === 'corner')
        .map((f) => (f.properties.role === 'corner' ? f.properties.name : ''));

      expect(corners).toEqual([
        'K1',
        'K2',
        'K3',
        'K4',
        'K5',
        'K6',
        'K7',
        'K8',
        'K9',
        'K10',
        'K11',
        'K12',
        'K13',
        'K14',
        'K15',
        'K16',
      ]);
    });

    it('sits under the seeded S/F gate', () => {
      // The whole point of the check inside buildTrackMap: an overlay that
      // does not align with the gate the analysis pass already segments laps
      // on would draw a racing line beside the circuit instead of on it. This
      // just confirms the fixture is the case that check is meant to pass.
      const result = buildTrackMap(response, SERRES_GATE);
      expect(result.outcome).toBe('built');
    });

    it('carries the data timestamp from osm3s, not the fetch time', () => {
      const result = buildTrackMap(response, SERRES_GATE);
      expect(result.outcome).toBe('built');
      if (result.outcome !== 'built') return;

      expect(result.osmDataTimestamp?.toISOString()).toBe(
        '2026-08-12T12:19:02.000Z',
      );
    });

    it('computes a bbox around the stitched ring', () => {
      const result = buildTrackMap(response, SERRES_GATE);
      expect(result.outcome).toBe('built');
      if (result.outcome !== 'built') return;

      expect(result.bbox.minLat).toBeLessThan(result.bbox.maxLat);
      expect(result.bbox.minLon).toBeLessThan(result.bbox.maxLon);
      // Sanity: the box should actually contain Serres, not the antipodes.
      expect(result.bbox.minLat).toBeGreaterThan(41);
      expect(result.bbox.maxLat).toBeLessThan(42);
    });
  });

  describe('against the real captured Kaloyanovo response — a single-way circuit', () => {
    // Kaloyanovo seed row's own S/F gate (apps/api/src/tracks/tracks.seed.ts).
    // The circuit is one closed way named after the circuit itself ("Дракон"),
    // plus a separate, shorter, unconnected pit-lane way ("Боксове") with no
    // `raceway=pit_lane` tag — excluded here by length, not by the tag filter.
    const gate = {
      lat1: 42.3411288,
      lon1: 24.737,
      lat2: 42.3409841,
      lon2: 24.7369101,
    };

    it("does not turn the way's own name into a corner feature", () => {
      const result = buildTrackMap(
        kaloyanovoOverpass as unknown as OverpassResponse,
        gate,
      );
      expect(result.outcome).toBe('built');
      if (result.outcome !== 'built') return;

      const roles = result.geojson.features.map((f) => f.properties.role);
      expect(roles).toEqual(['circuit']);
      expect(result.centrelineLengthM).toBeGreaterThan(2800);
      expect(result.centrelineLengthM).toBeLessThan(2950);
    });
  });

  describe('rejection', () => {
    it('rejects when there are no highway=raceway ways at all', () => {
      const empty: OverpassResponse = {
        version: 0.6,
        generator: 'test',
        osm3s: { timestamp_osm_base: '2026-01-01T00:00:00Z', copyright: '' },
        elements: [],
      };

      const result = buildTrackMap(empty, SERRES_GATE);
      expect(result).toEqual({
        outcome: 'rejected',
        reason: 'no-raceway-ways',
      });
    });

    it('rejects a ring that does not close', () => {
      const open: OverpassResponse = {
        version: 0.6,
        generator: 'test',
        osm3s: { timestamp_osm_base: '2026-01-01T00:00:00Z', copyright: '' },
        elements: [
          {
            type: 'way',
            id: 1,
            nodes: [1, 2, 3],
            geometry: [
              { lat: 41.0, lon: 23.5 },
              { lat: 41.001, lon: 23.501 },
              { lat: 41.002, lon: 23.502 },
            ],
            tags: { highway: 'raceway' },
          },
        ],
      };

      const result = buildTrackMap(open, SERRES_GATE);
      expect(result.outcome).toBe('rejected');
      if (result.outcome !== 'rejected') return;
      expect(result.reason).toContain('ring-not-closed');
    });

    it('rejects a closed ring whose gate is nowhere near it', () => {
      // A small closed square, real and well-formed, just not where the
      // track's surveyed S/F gate says the circuit should be.
      const square: OverpassResponse = {
        version: 0.6,
        generator: 'test',
        osm3s: { timestamp_osm_base: '2026-01-01T00:00:00Z', copyright: '' },
        elements: [
          {
            type: 'way',
            id: 1,
            nodes: [1, 2, 3, 4, 1],
            geometry: [
              { lat: 10.0, lon: 10.0 },
              { lat: 10.005, lon: 10.0 },
              { lat: 10.005, lon: 10.005 },
              { lat: 10.0, lon: 10.005 },
              { lat: 10.0, lon: 10.0 },
            ],
            tags: { highway: 'raceway', width: '10' },
          },
        ],
      };

      const result = buildTrackMap(square, SERRES_GATE);
      expect(result.outcome).toBe('rejected');
      if (result.outcome !== 'rejected') return;
      expect(result.reason).toContain('gate-not-on-ring');
    });

    it('excludes karting and pit-lane ways from the candidate set', () => {
      const onlyExcluded: OverpassResponse = {
        version: 0.6,
        generator: 'test',
        osm3s: { timestamp_osm_base: '2026-01-01T00:00:00Z', copyright: '' },
        elements: [
          {
            type: 'way',
            id: 1,
            nodes: [1, 2, 1],
            geometry: [
              { lat: 41.07, lon: 23.51 },
              { lat: 41.071, lon: 23.511 },
              { lat: 41.07, lon: 23.51 },
            ],
            tags: { highway: 'raceway', sport: 'karting' },
          },
          {
            type: 'way',
            id: 2,
            nodes: [3, 4],
            geometry: [
              { lat: 41.07, lon: 23.51 },
              { lat: 41.071, lon: 23.511 },
            ],
            tags: { highway: 'raceway', raceway: 'pit_lane' },
          },
        ],
      };

      const result = buildTrackMap(onlyExcluded, SERRES_GATE);
      expect(result).toEqual({
        outcome: 'rejected',
        reason: 'no-raceway-ways',
      });
    });
  });
});
