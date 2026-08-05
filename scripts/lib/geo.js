'use strict';

/**
 * Equirectangular projection helpers, at track scale.
 *
 * The constants are deliberately the *same* ones the on-car dash uses
 * (`kab23-motorsport-race-dash/src/raceboxmodel.cpp`): 111132 m per degree of
 * latitude, and 111320·cos(lat) per degree of longitude. The cloud's lap
 * segmentation is a port of that file's gate-crossing maths, so a mock built on
 * a different projection would produce traces that cross the line at slightly
 * different points than the dash would compute for the same drive — and the
 * discrepancy would look like a segmentation bug.
 *
 * A proper geodesic is overkill here and would actually be wrong: over a ~600 m
 * circuit the flat-earth error is well under a centimetre, and matching the
 * consumer's projection matters far more than absolute accuracy.
 */

const METERS_PER_DEG_LAT = 111132.0;

/** Metres per degree of longitude at the given latitude. */
const metersPerDegLon = (latDeg) =>
  111320.0 * Math.cos((latDeg * Math.PI) / 180);

/**
 * A local metric frame (x = east, y = north, metres) anchored at one origin.
 *
 * `metersPerDegLon` is evaluated **once**, at the origin, rather than per
 * point. That is what makes the mapping exactly invertible, which in turn is
 * what lets the circuit generator lay a track out in metres and place it on the
 * globe without the shape distorting. It is also precisely what the segmenter
 * does around the gate midpoint, so the two agree by construction.
 */
function localFrame(originLat, originLon) {
  const mLon = metersPerDegLon(originLat);

  return {
    toLocal: (lat, lon) => ({
      x: (lon - originLon) * mLon,
      y: (lat - originLat) * METERS_PER_DEG_LAT,
    }),
    toGeo: (x, y) => ({
      lat: originLat + y / METERS_PER_DEG_LAT,
      lon: originLon + x / mLon,
    }),
  };
}

/** Straight-line distance in metres. Flat-earth; see the note above. */
function distanceM(lat1, lon1, lat2, lon2) {
  const mLon = metersPerDegLon((lat1 + lat2) / 2);
  return Math.hypot(
    (lon2 - lon1) * mLon,
    (lat2 - lat1) * METERS_PER_DEG_LAT,
  );
}

module.exports = {
  METERS_PER_DEG_LAT,
  metersPerDegLon,
  localFrame,
  distanceM,
};
