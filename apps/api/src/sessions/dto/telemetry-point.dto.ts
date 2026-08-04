/**
 * One downsampled bucket, as returned by `GET /sessions/:id/telemetry`.
 *
 * Declared here rather than beside the query that produces it because it is the
 * endpoint's response contract, not a row shape: the SQL aliases in
 * `TelemetryRepository` exist to satisfy this, and renaming a column there must
 * not silently change what clients receive.
 */
export interface TelemetryPointDto {
  bucket: Date;
  rpm: number | null;
  coolantC: number | null;
  oilC: number | null;
  speedKmh: number | null;
  lat: number | null;
  lon: number | null;
  gLatPeak: number | null;
  gLonPeak: number | null;
  lapNumber: number | null;
  samples: number;
}
