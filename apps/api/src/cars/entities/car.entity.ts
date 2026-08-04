import { AbstractEntity } from '@app/common';
import { Column, Entity, Index, JoinColumn, ManyToOne } from 'typeorm';
import { User } from '../../users/entities/user.entity';
import { Team } from '../../teams/entities/team.entity';

// Postgres does not index foreign keys automatically, and both columns drive
// the `ownerId = ? OR teamId IN (…)` scoping predicate on every car read.
@Entity('cars')
@Index(['ownerId'])
@Index(['teamId'])
export class Car extends AbstractEntity<Car> {
  @Column()
  name: string;

  @Column({ nullable: true })
  make?: string;

  @Column({ nullable: true })
  model?: string;

  /**
   * The car's MQTT identity — it is the `<deviceId>` in `cars/<deviceId>/…`
   * (see `libs/common/src/constants/mqtt-topics.ts`), so Phase 2 resolves an
   * incoming frame to a car through this column. Unique across the platform.
   */
  @Column({ unique: true })
  deviceId: string;

  /**
   * When a broker credential was last issued for this car — never the secret
   * itself, nor a hash of it. The plaintext exists exactly once, in the
   * response to `POST /cars/:id/mqtt-credentials`; the broker keeps the only
   * durable copy (its own hash). A car that loses its credential rotates,
   * because there is nothing here to look it up from.
   *
   * Null means the device cannot connect: either never provisioned, or its
   * `deviceId` was changed, which revokes the old credential along with the old
   * ACLs.
   */
  @Column({ type: 'timestamptz', nullable: true })
  mqttProvisionedAt?: Date;

  @Column()
  ownerId: string;

  @ManyToOne(() => User, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'ownerId' })
  owner: User;

  /** Null for a privateer's car; set when the car runs under a team. */
  @Column({ nullable: true })
  teamId?: string;

  @ManyToOne(() => Team, { nullable: true, onDelete: 'SET NULL' })
  @JoinColumn({ name: 'teamId' })
  team?: Team;
}
