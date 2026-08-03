import { AbstractRepository } from '@app/common';
import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { EntityManager, Repository } from 'typeorm';
import { TeamInvite } from './entities/team-invite.entity';

@Injectable()
export class TeamInvitesRepository extends AbstractRepository<TeamInvite> {
  protected readonly logger: Logger = new Logger(TeamInvitesRepository.name);

  constructor(
    @InjectRepository(TeamInvite)
    invitesRepository: Repository<TeamInvite>,
    entityManager: EntityManager,
  ) {
    super(invitesRepository, entityManager);
  }

  /** Two managers inviting the same address at once collide on `(teamId, email)`. */
  async createInvite(invite: TeamInvite): Promise<TeamInvite> {
    return this.createOrConflict(invite, 'Invite already exists');
  }

  /**
   * Null on a miss — "is this address already invited?" is ordinary control
   * flow, and the inherited `findOne` throws on an empty result.
   */
  async findPending(teamId: string, email: string): Promise<TeamInvite | null> {
    const [invite] = await this.find({ teamId, email });
    return invite ?? null;
  }
}
