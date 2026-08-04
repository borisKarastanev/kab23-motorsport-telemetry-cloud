import { AbstractEntity, SessionStatus } from '@app/common';
import { Column, Entity } from 'typeorm';

/**
 * The ingest service's view of `apps/api`'s `sessions` table — see
 * `CarRef` for why the entity is duplicated rather than shared.
 *
 * Unlike `CarRef` this one is written as well as read: the device, not the web
 * app, decides when a run starts and ends, so ingest is what opens and closes
 * these rows.
 *
 * It extends `AbstractEntity` for the same reason `Session` does: `id`,
 * `createdAt` and `updatedAt` are NOT NULL columns that `apps/api` populates
 * through that base class, so an insert from here has to fill them the same
 * way. Inheriting it — rather than retyping the three columns — is also what
 * keeps this view correct if the base class ever changes.
 */
@Entity({ name: 'sessions', synchronize: false })
export class SessionRef extends AbstractEntity<SessionRef> {
  @Column()
  carId: string;

  @Column()
  driverId: string;

  @Column()
  track: string;

  @Column({ type: 'timestamptz' })
  startedAt: Date;

  @Column({ type: 'timestamptz', nullable: true })
  endedAt?: Date;

  @Column({ type: 'enum', enum: SessionStatus, default: SessionStatus.LIVE })
  status: SessionStatus;

  @Column({ type: 'uuid', unique: true, nullable: true })
  deviceSessionId?: string;

  @Column({ type: 'bigint', nullable: true })
  deviceMonoStartMs?: number;
}
