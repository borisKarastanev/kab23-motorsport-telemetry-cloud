import { AbstractRepository, TeamRole } from '@app/common';
import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { EntityManager, Repository } from 'typeorm';
import { TeamMember } from './entities/team-member.entity';

@Injectable()
export class TeamMembersRepository extends AbstractRepository<TeamMember> {
  protected readonly logger: Logger = new Logger(TeamMembersRepository.name);

  constructor(
    @InjectRepository(TeamMember)
    private readonly membersRepository: Repository<TeamMember>,
    entityManager: EntityManager,
  ) {
    super(membersRepository, entityManager);
  }

  /**
   * Returns null instead of throwing: "is this user a member?" is a question
   * whose negative answer is normal control flow, and the inherited `findOne`
   * throws `NotFoundException` on a miss.
   */
  async findMembership(
    userId: string,
    teamId: string,
  ): Promise<TeamMember | null> {
    return this.membersRepository.findOne({ where: { userId, teamId } });
  }

  /** Roster with display fields joined; never selects `user.password`. */
  async findRoster(teamId: string): Promise<TeamMember[]> {
    return this.membersRepository
      .createQueryBuilder('member')
      .leftJoin('member.user', 'user')
      .addSelect(['user.id', 'user.email', 'user.displayName', 'user.role'])
      .where('member.teamId = :teamId', { teamId })
      .orderBy('member.createdAt', 'ASC')
      .getMany();
  }

  async countByRole(teamId: string, role: TeamRole): Promise<number> {
    return this.membersRepository.countBy({ teamId, role });
  }
}
