/**
 * The mock and the API must agree about the earth and about the finish line.
 *
 * Two things are duplicated across the CommonJS/TypeScript boundary because
 * neither side can import the other: `scripts/` runs directly under `node` and
 * is not built, and `apps/api` cannot depend on a dev script. Both copies claim
 * in their own docblocks that agreement is load-bearing, and until now nothing
 * checked it:
 *
 * - **The projection.** `scripts/lib/geo.js` generates the racing line;
 *   `apps/api/src/analysis/geo.ts` decides where that line crosses the gate. A
 *   change to one moves computed crossing points relative to the other, which
 *   reads as a segmentation bug rather than as two answers to slightly
 *   different questions.
 * - **Kaloyanovo's S/F gate.** The mock drives across the gate in
 *   `scripts/lib/circuit.js`; the API cuts laps on the gate seeded by
 *   `tracks.seed.ts`. `tracks.seed.ts` explicitly invites correction, and a
 *   gate corrected there alone makes the mock drive across the *old* line — so
 *   every end-to-end check returns `no-crossings` with nothing saying why.
 *
 * The precedent is `apps/telemetry-ingest/src/sessions/entity-parity.spec.ts`:
 * a test is the right place for a boundary that a type cannot express.
 */
import {
  METERS_PER_DEG_LAT,
  distanceM,
  localFrame,
  metersPerDegLon,
} from '../../apps/api/src/analysis/geo';
import { TRACK_SEEDS } from '../../apps/api/src/tracks/tracks.seed';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const mockGeo = require('./geo');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { KALOYANOVO } = require('./circuit');

/** Points spread over the track, plus the poles of the projection's error. */
const SAMPLES: [number, number][] = [
  [42.3411288, 24.737],
  [42.341337751867, 24.734736084938],
  [42.35, 24.75],
  [0, 0],
  [51.5, -0.12],
  [-33.9, 151.2],
];

describe('projection parity between the mock and the analysis pass', () => {
  it('uses the same metres-per-degree constants', () => {
    expect(mockGeo.METERS_PER_DEG_LAT).toBe(METERS_PER_DEG_LAT);

    for (const [lat] of SAMPLES) {
      expect(mockGeo.metersPerDegLon(lat)).toBe(metersPerDegLon(lat));
    }
  });

  it('projects to the same local frame', () => {
    const [originLat, originLon] = SAMPLES[0];
    const mine = localFrame(originLat, originLon);
    const theirs = mockGeo.localFrame(originLat, originLon);

    for (const [lat, lon] of SAMPLES) {
      expect(theirs.toLocal(lat, lon)).toEqual(mine.toLocal(lat, lon));
    }
  });

  it('measures the same distances', () => {
    for (let i = 1; i < SAMPLES.length; i++) {
      const [aLat, aLon] = SAMPLES[i - 1];
      const [bLat, bLon] = SAMPLES[i];

      expect(mockGeo.distanceM(aLat, aLon, bLat, bLon)).toBe(
        distanceM(aLat, aLon, bLat, bLon),
      );
    }
  });
});

describe('Kaloyanovo parity between the mock and the seed', () => {
  const seeded = TRACK_SEEDS.find((track) => track.slug === 'kaloyanovo');

  it('is still seeded', () => {
    expect(seeded).toBeDefined();
  });

  it('drives across the gate the API cuts laps on', () => {
    // A corrected gate has to move in both places or the mock crosses the old
    // line and derives nothing.
    expect({
      lat1: seeded.sfLat1,
      lon1: seeded.sfLon1,
      lat2: seeded.sfLat2,
      lon2: seeded.sfLon2,
    }).toEqual(KALOYANOVO.gate);
  });

  it('agrees on the circuit centre', () => {
    expect({ lat: seeded.centreLat, lon: seeded.centreLon }).toEqual(
      KALOYANOVO.centre,
    );
  });
});
