import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { AnalysisSample } from './analysis.types';

/**
 * Raw sample reads for the analysis pass.
 *
 * **Raw, not downsampled** — the one thing this must not share with
 * `TelemetryRepository`. That repository's `time_bucket` rollup averages
 * position across a bucket, which puts the car somewhere it never was; it says
 * so itself, and it is right. A racing line built from averaged fixes cuts
 * every corner, and a gate crossing computed from one is a coin toss. So the
 * analysis path reads every row in the window and decimates afterwards, by
 * distance, where the geometry survives.
 *
 * Raw SQL for the same reason `TelemetryRepository` uses it: `TelemetrySample`
 * belongs to `apps/telemetry-ingest`, and `apps/api` must not import it.
 *
 * This class does no authorization. `AnalysisService` scopes the session before
 * every call, and is the only caller.
 */
/**
 * The projection every read here shares.
 *
 * `::float` on the real/double columns: node-postgres hands `numeric` back as a
 * string to preserve precision, and a lat arriving as "42.34" would make every
 * distance NaN rather than fail loudly.
 */
const SAMPLE_COLUMNS = `time,
              lat::float              AS lat,
              lon::float              AS lon,
              speed_kmh::float        AS "speedKmh",
              rpm,
              coolant_c::float        AS "coolantC",
              oil_c::float            AS "oilC",
              g_lat::float            AS "gLat",
              g_lon::float            AS "gLon"`;

@Injectable()
export class AnalysisSamplesRepository {
  constructor(@InjectDataSource() private readonly dataSource: DataSource) {}

  /**
   * Every sample in the window, in time order.
   *
   * Time order is not incidental — `LapSegmenter` compares each fix against the
   * previous one, so an out-of-order row would read as the car teleporting
   * backwards and, near the line, as a wrong-way crossing.
   */
  findRange(
    sessionId: string,
    from: Date,
    to: Date,
  ): Promise<AnalysisSample[]> {
    return this.dataSource.query(
      `SELECT ${SAMPLE_COLUMNS}
         FROM telemetry_samples
        WHERE session_id = $1
          AND time >= $2
          AND time <= $3
        ORDER BY time, seq`,
      [sessionId, from, to],
    );
  }

  /**
   * A lap's samples **plus the one fix either side of it**.
   *
   * `Lap.startedAt` and `Lap.endedAt` are the *interpolated* instants the car
   * crossed the line, so by construction they fall strictly between two stored
   * samples and `findRange` would return neither of the fixes that bracket
   * them. The trace built from that starts at the first sample *after* the
   * line — up to a fix interval, ~5 m at 185 km/h, down the road — which is
   * exactly the phantom delta `LapSegmenter`'s anchoring exists to remove: two
   * laps would get distance axes with different physical origins, and
   * `compareLaps` aligns on that axis.
   *
   * So hand the bracketing fixes back too and let `buildLapTrace` interpolate
   * the endpoints onto the line itself.
   */
  findLapWindow(
    sessionId: string,
    from: Date,
    to: Date,
  ): Promise<AnalysisSample[]> {
    // `seq` is projected here and nowhere else: the outer ORDER BY needs it to
    // break ties within a millisecond, and one lap's worth of rows can carry it
    // for free. `findRange` reads up to MAX_ANALYSIS_SAMPLES rows and would be
    // paying for a column nothing reads, which is why it is not in
    // SAMPLE_COLUMNS.
    return this.dataSource.query(
      `SELECT * FROM (
                (SELECT ${SAMPLE_COLUMNS}, seq
                   FROM telemetry_samples
                  WHERE session_id = $1 AND time < $2
                  ORDER BY time DESC, seq DESC
                  LIMIT 1)
                UNION ALL
                (SELECT ${SAMPLE_COLUMNS}, seq
                   FROM telemetry_samples
                  WHERE session_id = $1 AND time >= $2 AND time <= $3)
                UNION ALL
                (SELECT ${SAMPLE_COLUMNS}, seq
                   FROM telemetry_samples
                  WHERE session_id = $1 AND time > $3
                  ORDER BY time, seq
                  LIMIT 1)
              ) AS w
        ORDER BY w.time, w.seq`,
      [sessionId, from, to],
    );
  }

  /**
   * How many samples the window holds.
   *
   * Checked before reading them: derivation runs inside the request that asked
   * for the laps (§0.3 of the Phase 4 plan), so an eight-hour session left open
   * at a track day would otherwise pull hundreds of thousands of rows into one
   * HTTP handler's heap. Counting first lets that case be refused with a reason
   * rather than by running the API out of memory.
   */
  async countRange(sessionId: string, from: Date, to: Date): Promise<number> {
    const [{ count }] = await this.dataSource.query(
      `SELECT count(*)::int AS count
         FROM telemetry_samples
        WHERE session_id = $1
          AND time >= $2
          AND time <= $3`,
      [sessionId, from, to],
    );

    return count;
  }
}
