import { AbstractEntity, SessionStatus } from '@app/common';
import { Column, Entity, Index, JoinColumn, ManyToOne } from 'typeorm';
import { User } from '../../users/entities/user.entity';
import { Car } from '../../cars/entities/car.entity';
// A leaf import: `analysis.types.ts` is pure shapes and imports nothing at
// all, so this does not pull the analysis module into the entity layer. The
// alternative was respelling the union here, where nothing would catch the two
// copies drifting apart if a third scheme is ever added.
import { SectorScheme } from '../../analysis/analysis.types';

/**
 * One on-track run: a car, a driver, and a time window.
 *
 * Phase 2 attaches telemetry samples to this row, so `carId` + the time window
 * are what make an incoming MQTT frame attributable to a tenant.
 */
@Entity('sessions')
@Index(['carId', 'startedAt'])
// The other half of the `driverId = ? OR carId IN (…)` scoping predicate, and
// the sort key for the default GET /sessions listing.
@Index(['driverId', 'startedAt'])
export class Session extends AbstractEntity<Session> {
  @Column()
  carId: string;

  @ManyToOne(() => Car, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'carId' })
  car: Car;

  @Column()
  driverId: string;

  @ManyToOne(() => User, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'driverId' })
  driver: User;

  @Column()
  track: string;

  @Column({ type: 'timestamptz' })
  startedAt: Date;

  @Column({ type: 'timestamptz', nullable: true })
  endedAt?: Date;

  @Column({ type: 'enum', enum: SessionStatus, default: SessionStatus.LIVE })
  status: SessionStatus;

  /**
   * The `sid` the device generated for this run — its idempotency key.
   *
   * A car spools telemetry locally when the LTE link drops and replays it on
   * reconnect, possibly long after the run ended and possibly more than once.
   * Unique, so a replayed backlog resolves back to this row instead of opening
   * a second session, and a duplicated `start` event is a no-op.
   *
   * Null for sessions opened through the REST API rather than by a device.
   */
  @Column({ type: 'uuid', unique: true, nullable: true })
  deviceSessionId?: string;

  /**
   * The device's monotonic clock reading at `startedAt`.
   *
   * A Pi 4 has no RTC, so a frame's wall-clock stamp is unreliable until NTP
   * syncs over LTE. Sample time is instead `startedAt + (frame.mono -
   * deviceMonoStartMs)`, which keeps one run's samples contiguous even if the
   * device's clock steps mid-session. Storing it here is what lets ingest
   * rebuild that anchor after a restart, when its in-memory registry is gone.
   */
  @Column({ type: 'bigint', nullable: true })
  deviceMonoStartMs?: number;

  /**
   * When the lap derivation last ran over this session — the flag that makes
   * `GET /sessions/:id/laps` lazy.
   *
   * Null means "not derived yet", so the first read of a completed session
   * segments it and writes the `laps` rows. Set **last**, after those rows are
   * committed, so a crash mid-derivation leaves the session looking underived
   * and the next read simply tries again. See `AnalysisService`.
   *
   * A recompute (a corrected gate, a device disagreeing with us) replaces the
   * laps and moves this forward in one step — it never clears either, or a
   * re-derivation that could not run would destroy the answer already held.
   */
  @Column({ type: 'timestamptz', nullable: true })
  analyzedAt?: Date;

  /**
   * How the laps derived at `analyzedAt` split their sectors.
   *
   * `'gates'` once a fixed sector gate set (surveyed or derived) was used;
   * null on every row derived before this column existed and on any session
   * whose track still has no gate of any kind — both read as the legacy
   * distance-fraction fallback. Set alongside `analyzedAt` and never on its
   * own, so the two can never disagree about which derivation produced the
   * laps currently stored.
   */
  @Column({ type: 'text', nullable: true })
  sectorScheme?: SectorScheme;
}
