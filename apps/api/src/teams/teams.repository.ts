import { AbstractRepository, TeamRole } from '@app/common';
import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { EntityManager, In, Repository } from 'typeorm';
import { Team } from './entities/team.entity';
import { TeamMember } from './entities/team-member.entity';

@Injectable()
export class TeamsRepository extends AbstractRepository<Team> {
  protected readonly logger: Logger = new Logger(TeamsRepository.name);

  constructor(
    @InjectRepository(Team)
    private readonly teamsRepository: Repository<Team>,
    private readonly manager: EntityManager,
  ) {
    super(teamsRepository, manager);
  }

  /**
   * A team with no owner is unreachable — nobody could ever administer it — so
   * the team row and its founding OWNER membership are written together or not
   * at all.
   */
  async createWithOwner(name: string, ownerId: string): Promise<Team> {
    return this.manager.transaction(async (transactionManager) => {
      const team = await transactionManager.save(new Team({ name }));

      await transactionManager.save(
        new TeamMember({
          teamId: team.id,
          userId: ownerId,
          role: TeamRole.OWNER,
        }),
      );

      return team;
    });
  }

  /** An empty id list must return nothing, not degrade to "every team". */
  async findByIds(ids: string[]): Promise<Team[]> {
    if (!ids.length) {
      return [];
    }
    return this.teamsRepository.find({
      where: { id: In(ids) },
      order: { name: 'ASC' },
    });
  }
}
