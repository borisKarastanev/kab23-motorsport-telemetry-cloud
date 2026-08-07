import { Column, Entity, PrimaryColumn } from 'typeorm';

/**
 * One 10 Hz telemetry sample. Backed by a TimescaleDB **hypertable**, not an
 * ordinary table. The DDL lives in the baseline migration
 * (`db/migrations/*-Baseline.ts`); `TelemetrySchemaGuard` checks on boot that it
 * was actually run.
 *
 * Two deliberate departures from every other entity in this repo:
 *
 * 1. **It does not extend `AbstractEntity`.** A uuid primary key on an
 *    append-only table taking 10 rows/second/car is dead weight, and
 *    `createdAt`/`updatedAt` are meaningless for a sample that is never
 *    updated. The primary key here is the natural one, `(time, sessionId,
 *    seq)`, which is also the dedup key that makes a replayed backfill batch a
 *    no-op.
 * 2. **Columns are snake_case.** This table is queried by hand far more than
 *    the domain tables are (`time_bucket` rollups, the hypertable DDL itself),
 *    and camelCase identifiers would need double-quoting in every one of those
 *    statements.
 *
 * `synchronize: false` is load-bearing: TypeORM knows nothing about
 * `create_hypertable`, so left to itself it would happily drop this and
 * recreate it as a plain table on the next entity edit.
 */
@Entity({ name: 'telemetry_samples', synchronize: false })
export class TelemetrySample {
  /**
   * Server-anchored sample time — NOT the device's wall clock. A Pi 4 has no
   * RTC, so a frame's `ts` is unreliable until NTP syncs over LTE; ingest
   * anchors to its own clock at session start and advances by the device's
   * monotonic counter. See `DeviceRegistryService`.
   */
  @PrimaryColumn({ type: 'timestamptz', name: 'time' })
  time: Date;

  @PrimaryColumn({ type: 'uuid', name: 'session_id' })
  sessionId: string;

  /** Monotonic per session, assigned by the device. Half of the dedup key. */
  @PrimaryColumn({ type: 'bigint', name: 'seq' })
  seq: number;

  /**
   * Denormalised from the session so a per-car scan never joins back, and so
   * tenant scoping stays a single predicate.
   */
  @Column({ type: 'uuid', name: 'car_id' })
  carId: string;

  @Column({ type: 'integer', nullable: true })
  rpm?: number;

  @Column({ type: 'real', name: 'coolant_c', nullable: true })
  coolantC?: number;

  @Column({ type: 'real', name: 'oil_c', nullable: true })
  oilC?: number;

  @Column({ type: 'real', name: 'speed_kmh', nullable: true })
  speedKmh?: number;

  @Column({ type: 'double precision', nullable: true })
  lat?: number;

  @Column({ type: 'double precision', nullable: true })
  lon?: number;

  /** Lateral / longitudinal / vertical acceleration, in g. */
  @Column({ type: 'real', name: 'g_lat', nullable: true })
  gLat?: number;

  @Column({ type: 'real', name: 'g_lon', nullable: true })
  gLon?: number;

  @Column({ type: 'real', name: 'g_vert', nullable: true })
  gVert?: number;

  @Column({ type: 'integer', name: 'lap_number', nullable: true })
  lapNumber?: number;

  @Column({ type: 'integer', name: 'lap_ms', nullable: true })
  lapMs?: number;

  /** Channels not (yet) worth a column of their own. */
  @Column({ type: 'jsonb', nullable: true })
  ext?: Record<string, unknown>;
}
