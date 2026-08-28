import { TrackMap, TrackMapStatus } from './entities/track-map.entity';
import { PENDING } from './track-map.types';

/**
 * Reading a cached track map back, for consumers that want the geometry rather
 * than the wire shape.
 *
 * `toTrackMapResponseDto` is the other reader, and it answers the browser. This
 * one answers the analysis pass, which wants the circuit's centreline to derive
 * sector gates from and nothing else. Both need the same two pieces of
 * knowledge — what "ready" means, and which feature of the collection is the
 * circuit — and this is the module that owns them. `AnalysisService` held its
 * own copy of both, so a change to `TrackMapFeature`'s `role` tagging or a
 * third `TrackMapStatus` would have had to be chased into `analysis/` by hand,
 * with nothing to point the way. Mirrors the `isCircuit` guard the frontend
 * already shares between its two map consumers.
 */
export interface ReadyCircuit {
  /** The centreline, in the ring's own winding — direction is not implied. */
  ring: { lat: number; lon: number }[];
  centrelineLengthM: number;
}

/**
 * The circuit centreline of a ready track map, or `undefined`.
 *
 * `undefined` for every not-ready case — a fetch still running (`PENDING`), an
 * `unavailable` row, or a ready row whose collection somehow carries no
 * circuit feature. A caller that wanted the ring cannot use any of them, and
 * telling them apart is `toTrackMapResponseDto`'s job, not this one's.
 */
export function readyCircuit(
  trackMap: TrackMap | typeof PENDING,
): ReadyCircuit | undefined {
  if (trackMap === PENDING || trackMap.status !== TrackMapStatus.READY) {
    return undefined;
  }

  const circuit = trackMap.geojson?.features.find(
    (feature) => feature.properties.role === 'circuit',
  );
  if (!circuit) {
    return undefined;
  }

  return {
    // GeoJSON is [lon, lat]; everything under `analysis/` is {lat, lon}.
    ring: circuit.geometry.coordinates.map(([lon, lat]) => ({ lat, lon })),
    centrelineLengthM: trackMap.centrelineLengthM,
  };
}
