import { AbstractEntity, SessionStatus } from '@app/common';
import { Column, Entity, Index, JoinColumn, ManyToOne } from 'typeorm';
import { User } from '../../users/entities/user.entity';
import { Car } from '../../cars/entities/car.entity';

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
}
