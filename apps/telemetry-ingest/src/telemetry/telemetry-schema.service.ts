import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';

/**
 * Creates the telemetry hypertable if it is not already there.
 *
 * `synchronize: true` cannot own this table — TypeORM has no idea what
 * `create_hypertable` is — so the DDL lives here instead, and this is its
 * **only** copy. Putting it in `db/init/` was the obvious alternative and is
 * wrong: `docker-entrypoint-initdb.d` runs only against an empty data
 * directory, so every existing dev database would silently never get the
 * table, and a second copy of the DDL would drift from this one.
 *
 * Every statement is `IF NOT EXISTS` / `if_not_exists => TRUE`, so this is a
 * no-op on all but the first boot.
 *
 * Phase 5 replaces this with a TypeORM migration, along with the rest of the
 * schema, and adds the compression and retention policies.
 */
@Injectable()
export class TelemetrySchemaService implements OnModuleInit {
  private readonly logger = new Logger(TelemetrySchemaService.name);

  constructor(@InjectDataSource() private readonly dataSource: DataSource) {}

  async onModuleInit(): Promise<void> {
    for (const statement of TelemetrySchemaService.DDL) {
      await this.dataSource.query(statement);
    }

    this.logger.log('Telemetry hypertable ready');
  }

  /**
   * Ordered: the table has to exist before it can become a hypertable, and
   * Timescale requires the partitioning column in every unique index — which is
   * why the dedup index is `(session_id, seq, time)` and not `(session_id,
   * seq)`. That still dedupes exactly, because `time` is derived
   * deterministically from the session's anchor plus the frame's monotonic
   * counter, so the same frame always lands on the same timestamp.
   */
  private static readonly DDL = [
    // Already enabled by db/init/01-timescaledb.sql on a fresh volume; repeated
    // here so this service is sufficient on its own for a database that
    // predates it.
    `CREATE EXTENSION IF NOT EXISTS timescaledb`,

    `CREATE TABLE IF NOT EXISTS telemetry_samples (
       time        TIMESTAMPTZ      NOT NULL,
       session_id  UUID             NOT NULL,
       seq         BIGINT           NOT NULL,
       car_id      UUID             NOT NULL,
       rpm         INTEGER,
       coolant_c   REAL,
       oil_c       REAL,
       speed_kmh   REAL,
       lat         DOUBLE PRECISION,
       lon         DOUBLE PRECISION,
       g_lat       REAL,
       g_lon       REAL,
       g_vert      REAL,
       lap_number  INTEGER,
       lap_ms      INTEGER,
       ext         JSONB
     )`,

    `SELECT create_hypertable('telemetry_samples', 'time',
       chunk_time_interval => INTERVAL '1 day',
       if_not_exists => TRUE)`,

    `CREATE UNIQUE INDEX IF NOT EXISTS telemetry_samples_dedup
       ON telemetry_samples (session_id, seq, time)`,

    `CREATE INDEX IF NOT EXISTS telemetry_samples_session_time
       ON telemetry_samples (session_id, time DESC)`,

    `CREATE INDEX IF NOT EXISTS telemetry_samples_car_time
       ON telemetry_samples (car_id, time DESC)`,
  ];
}
