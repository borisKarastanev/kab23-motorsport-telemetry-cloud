import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { TelemetryPointDto } from './dto/telemetry-point.dto';

/** Never bucket finer than the 10 Hz publish rate — it would add empty rows. */
const MIN_BUCKET_MS = 100;

/**
 * Downsampled reads from the telemetry hypertable.
 *
 * Raw SQL rather than an entity: `TelemetrySample` belongs to the ingest
 * service, and duplicating it here to run one aggregate query would be a third
 * copy of the same table definition to keep in step. Everything this returns is
 * a rollup anyway, so there is no entity to hydrate.
 *
 * This class does no authorization. Callers must scope the session first —
 * `SessionsService.getTelemetry` is the only entry point, and it does.
 */
@Injectable()
export class TelemetryRepository {
  constructor(@InjectDataSource() private readonly dataSource: DataSource) {}

  async findDownsampled(
    sessionId: string,
    from: Date,
    to: Date,
    maxPoints: number,
  ): Promise<TelemetryPointDto[]> {
    const rangeMs = Math.max(to.getTime() - from.getTime(), MIN_BUCKET_MS);

    // Divided by maxPoints - 1, not maxPoints: `time_bucket` aligns buckets to
    // the epoch rather than to `from`, so a window of exactly N bucket-widths
    // straddles N + 1 boundaries unless it happens to start on one. Sizing off
    // maxPoints alone therefore overshoots the cap by one, which makes a
    // parameter named "max" untrue for a caller sizing a buffer to it.
    const bucketMs = Math.max(
      MIN_BUCKET_MS,
      Math.ceil(rangeMs / Math.max(maxPoints - 1, 1)),
    );

    // `first`/`last` (Timescale aggregates) rather than `avg` for position and
    // lap: averaging two fixes either side of a corner puts the car somewhere
    // it never was, which is exactly what a racing line must not do. Scalar
    // channels average fine.
    return this.dataSource.query(
      // The ::float casts are not cosmetic: avg() over an integer column
      // returns `numeric`, which node-postgres hands back as a *string* to
      // preserve arbitrary precision. Without the cast `rpm` would serialise as
      // "3370.25" while every neighbouring channel was a number.
      `SELECT time_bucket(make_interval(secs => $1), time) AS bucket,
              avg(rpm)::float          AS rpm,
              avg(coolant_c)::float    AS "coolantC",
              avg(oil_c)::float        AS "oilC",
              avg(speed_kmh)::float    AS "speedKmh",
              first(lat, time)         AS lat,
              first(lon, time)         AS lon,
              max(abs(g_lat))          AS "gLatPeak",
              max(abs(g_lon))          AS "gLonPeak",
              last(lap_number, time)   AS "lapNumber",
              count(*)::int            AS samples
         FROM telemetry_samples
        WHERE session_id = $2
          AND time >= $3
          AND time <= $4
        GROUP BY bucket
        ORDER BY bucket`,
      [bucketMs / 1000, sessionId, from, to],
    );
  }
}
