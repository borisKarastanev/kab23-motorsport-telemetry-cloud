import { AbstractEntity, TeamRole } from '@app/common';
import { Column, Entity, Index, JoinColumn, ManyToOne } from 'typeorm';
import { Team } from './team.entity';

/**
 * A membership offered to an email address, pending that person's consent.
 *
 * Every invite lands here regardless of whether the address has an account —
 * that symmetry is what stops `POST /teams/:id/members` from becoming an
 * account-existence oracle. `TeamsService.acceptInvite` deletes the row once
 * the invitee accepts, so a pending invite is by definition an unaccepted one.
 */
@Entity('team_invites')
@Index(['teamId', 'email'], { unique: true })
// `GET /invites` looks up by address alone, which the composite above cannot serve.
@Index(['email'])
export class TeamInvite extends AbstractEntity<TeamInvite> {
  @Column()
  teamId: string;

  @ManyToOne(() => Team, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'teamId' })
  team: Team;

  /** Always stored lowercased, or claim-time matching silently misses. */
  @Column()
  email: string;

  @Column({ type: 'enum', enum: TeamRole, default: TeamRole.DRIVER })
  role: TeamRole;
}
