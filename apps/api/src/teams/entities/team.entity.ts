import { AbstractEntity } from '@app/common';
import { Column, Entity, OneToMany } from 'typeorm';
import { TeamMember } from './team-member.entity';

@Entity('teams')
export class Team extends AbstractEntity<Team> {
  @Column()
  name: string;

  @OneToMany(() => TeamMember, (member) => member.team, { cascade: ['remove'] })
  members: TeamMember[];
}
