import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';

/**
 * Refuses to start if the telemetry hypertable is missing.
 *
 * Until Phase 5 this class *created* the table, because `synchronize: true`
 * could not — TypeORM knows nothing about `create_hypertable` and would have
 * recreated it as a plain table. The DDL now lives in the baseline migration
 * (`db/migrations/*-Baseline.ts`) along with the rest of the schema, so there is
 * still exactly one copy of it; what is left here is the half worth keeping.
 *
 * Creating it on boot was never really about convenience — it was about ingest
 * being unable to start against a database that could not hold a sample. Under
 * migrations that failure mode comes back, and it comes back *worse*: nothing
 * would go wrong until the first frame arrives, at which point the write path
 * throws once per batch, forever, on a car that is already out on track. So the
 * check stays and moves to boot, matching the reasoning behind the required
 * `MQTT_USERNAME` in `config.schema.ts` — fail here, not at the track.
 *
 * Checking for the *hypertable* rather than the table is deliberate. A plain
 * `telemetry_samples` table would accept every insert and look healthy while
 * silently giving up chunking, compression and every time-series query plan the
 * analysis endpoints assume.
 */
@Injectable()
export class TelemetrySchemaGuard implements OnModuleInit {
  private readonly logger = new Logger(TelemetrySchemaGuard.name);

  static readonly TABLE = 'telemetry_samples';

  constructor(@InjectDataSource() private readonly dataSource: DataSource) {}

  async onModuleInit(): Promise<void> {
    const rows = await this.dataSource.query(
      `SELECT 1 FROM timescaledb_information.hypertables
        WHERE hypertable_name = $1`,
      [TelemetrySchemaGuard.TABLE],
    );

    if (!rows?.length) {
      throw new Error(
        `Hypertable "${TelemetrySchemaGuard.TABLE}" is missing. ` +
          'Run `pnpm run migration:run` against this database before starting ' +
          'telemetry-ingest.',
      );
    }

    this.logger.log('Telemetry hypertable present');
  }
}
