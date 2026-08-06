/**
 * Equirectangular projection at track scale.
 *
 * The constants are deliberately the *same* ones the on-car dash uses
 * (`kab23-motorsport-race-dash/src/raceboxmodel.cpp`) and the same ones
 * `scripts/lib/geo.js` uses to generate the mock's circuit: 111132 m per degree
 * of latitude, 111320·cos(lat) per degree of longitude. Three components now
 * agree by construction — the producer of the trace, the consumer that
 * segments it, and the device that timed the same laps on the car. A different
 * projection here would move computed crossing points a few centimetres off the
 * dash's, and the discrepancy would read as a segmentation bug rather than as
 * two correct answers to slightly different questions.
 *
 * A geodesic would be more accurate in the absolute and less useful here: over
 * a 2 km circuit the flat-earth error is sub-centimetre, and agreeing with the
 * other two implementations matters more.
 */

export const METERS_PER_DEG_LAT = 111132.0;

/** Metres per degree of longitude at the given latitude. */
export const metersPerDegLon = (latDeg: number): number =>
  111320.0 * Math.cos((latDeg * Math.PI) / 180);

/**
 * A local metric frame (x = east, y = north, metres) anchored at one origin.
 *
 * `metersPerDegLon` is evaluated **once**, at the origin, rather than per
 * point — the same choice `scripts/lib/geo.js` makes, and for the same reason:
 * it keeps the mapping linear, so distances and intersections computed in the
 * frame mean what they say across the whole track.
 */
export function localFrame(originLat: number, originLon: number) {
  const mLon = metersPerDegLon(originLat);

  return {
    toLocal: (lat: number, lon: number) => ({
      x: (lon - originLon) * mLon,
      y: (lat - originLat) * METERS_PER_DEG_LAT,
    }),
    toGeo: (x: number, y: number) => ({
      lat: originLat + y / METERS_PER_DEG_LAT,
      lon: originLon + x / mLon,
    }),
  };
}

/** Straight-line distance in metres. Flat-earth; see the note above. */
export function distanceM(
  lat1: number,
  lon1: number,
  lat2: number,
  lon2: number,
): number {
  const mLon = metersPerDegLon((lat1 + lat2) / 2);
  return Math.hypot((lon2 - lon1) * mLon, (lat2 - lat1) * METERS_PER_DEG_LAT);
}
