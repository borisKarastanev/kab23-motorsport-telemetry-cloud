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
