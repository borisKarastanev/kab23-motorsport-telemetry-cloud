import { AbstractEntity } from '@app/common';
import { Column, Entity, Index, JoinColumn, ManyToOne } from 'typeorm';
import { Session } from '../../sessions/entities/session.entity';
import { BrakingPoint } from '../analysis.types';

/**
 * One derived lap.
 *
 * **Derived, not recorded.** Every column here is recomputable from the
 * session's samples and the track's gate, and `POST /sessions/:id/analyze`
 * exists to do exactly that. The row is a cache with a stable identity, which
 * is what makes the lazy-derivation scheme in `AnalysisService` safe: losing
 * these rows costs a recompute, never data.
 *
 * An ordinary `synchronize: true` entity. Unlike `TelemetrySample` this is a
 * domain table — a few dozen rows per session, not ten a second — so it wants
 * the uuid key and the timestamps `AbstractEntity` brings, and it lands in
 * Phase 5's migration baseline with the rest of the domain model.
 */
@Entity('laps')
// The only lookup: every lap of one session, in order. Unique because it is
// also the concurrency guard — two tabs opening the same freshly-closed session
// race to derive it, and the loser's insert must collide rather than duplicate
// the lap table. See `LapsRepository.insertIgnoringDuplicates`.
@Index(['sessionId', 'lapNumber'], { unique: true })
export class Lap extends AbstractEntity<Lap> {
  @Column({ type: 'uuid' })
  sessionId: string;

  @ManyToOne(() => Session, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'sessionId' })
  session: Session;

  /**
   * 1-based, and deliberately matching the device's own numbering: the samples
   * the car stamped `lap_number = 1` are the ones this row describes. The
   * out-lap is lap 0 in both schemes and is not a row here, because it has no
   * lap time.
   */
  @Column({ type: 'integer' })
  lapNumber: number;

  /** The interpolated moment the car crossed the line, not a fix boundary. */
  @Column({ type: 'timestamptz' })
  startedAt: Date;

  @Column({ type: 'timestamptz' })
  endedAt: Date;

  @Column({ type: 'integer' })
  lapMs: number;

  /**
   * Distance covered, integrated from the speed channel rather than differenced
   * from the fixes — see `LapSegmenter.stepM` for why that distinction is worth
   * a comment on a column.
   */
  @Column({ type: 'integer' })
  distanceM: number;

  @Column({ type: 'real', nullable: true })
  maxSpeedKmh?: number;

  @Column({ type: 'real', nullable: true })
  minSpeedKmh?: number;

  /**
   * Per-sector durations, summing to `lapMs`. Empty when the lap could not be
   * split — see `sectors.ts`, which is explicit that these are distance
   * fractions rather than gate splits.
   */
  @Column({ type: 'integer', array: true, default: () => "'{}'" })
  sectorMs: number[];

  /**
   * Where the driver got on the brakes, as JSONB rather than a child table.
   *
   * These are read as a set, always all of them, always for one lap, and never
   * queried by their contents — the map overlay wants "this lap's markers" in
   * the same round trip as the lap itself. A `braking_points` table would add a
   * join to every read of that shape to buy filtering nobody does.
   */
  @Column({ type: 'jsonb', default: () => "'[]'" })
  brakingPoints: BrakingPoint[];

  /**
   * The session's fastest lap.
   *
   * Stored rather than derived on read so the session list can show a best lap
   * without pulling every lap of every session. Recomputed wholesale on each
   * derivation, since adding a lap can only move it.
   */
  @Column({ type: 'boolean', default: false })
  isBest: boolean;
}
