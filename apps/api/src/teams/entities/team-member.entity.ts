import { AbstractEntity, TeamRole } from '@app/common';
import { Column, Entity, Index, JoinColumn, ManyToOne } from 'typeorm';
import { User } from '../../users/entities/user.entity';
import { Team } from './team.entity';

@Entity('team_members')
@Index(['teamId', 'userId'], { unique: true })
// "Which teams is this user in?" runs on every GET /teams, /cars, and
// /sessions, and cannot use the composite index above — teamId leads it.
@Index(['userId'])
export class TeamMember extends AbstractEntity<TeamMember> {
  @Column()
  teamId: string;

  @ManyToOne(() => Team, (team) => team.members, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'teamId' })
  team: Team;

  @Column()
  userId: string;

  // Not eager: a membership is usually read for its role alone, and pulling the
  // User in by default would drag the password hash into every roster query.
  @ManyToOne(() => User, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'userId' })
  user: User;

  @Column({ type: 'enum', enum: TeamRole, default: TeamRole.DRIVER })
  role: TeamRole;
}
