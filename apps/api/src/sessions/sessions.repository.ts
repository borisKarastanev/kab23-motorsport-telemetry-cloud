import { AbstractRepository, SessionStatus } from '@app/common';
import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { EntityManager, Repository, SelectQueryBuilder } from 'typeorm';
import { Session } from './entities/session.entity';

@Injectable()
export class SessionsRepository extends AbstractRepository<Session> {
  protected readonly logger: Logger = new Logger(SessionsRepository.name);

  constructor(
    @InjectRepository(Session)
    private readonly sessionsRepository: Repository<Session>,
    entityManager: EntityManager,
  ) {
    super(sessionsRepository, entityManager);
  }

  /**
   * Sessions matching a caller-scoped set of driver and car ids.
   *
   * Both are resolved by `SessionsService` *before* this runs, so an empty
   * `carIds` genuinely means "no visible cars" — it must never widen into an
   * unfiltered scan. `driverId` is null when the caller narrowed the query to a
   * specific car or team, where their own unrelated sessions do not belong in
   * the result.
   */
  async findVisible(
    driverId: string | null,
    carIds: string[],
    status?: SessionStatus,
  ): Promise<Session[]> {
    const scopes: string[] = [];

    if (driverId) {
      scopes.push('session.driverId = :driverId');
    }
    if (carIds.length) {
      scopes.push('session.carId IN (:...carIds)');
    }
    // An empty scope selects nothing, rather than everything.
    if (!scopes.length) {
      return [];
    }

    const query = this.sessionsRepository
      .createQueryBuilder('session')
      .where(`(${scopes.join(' OR ')})`, { driverId, carIds });

    return this.finish(query, status);
  }

  async findAllFiltered(status?: SessionStatus): Promise<Session[]> {
    return this.finish(
      this.sessionsRepository.createQueryBuilder('session'),
      status,
    );
  }

  /** Shared tail so the admin and tenant read paths cannot drift on ordering. */
  private finish(
    query: SelectQueryBuilder<Session>,
    status?: SessionStatus,
  ): Promise<Session[]> {
    if (status) {
      query.andWhere('session.status = :status', { status });
    }

    return query.orderBy('session.startedAt', 'DESC').getMany();
  }
}
