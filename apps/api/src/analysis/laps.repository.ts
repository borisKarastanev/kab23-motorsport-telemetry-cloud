import { AbstractRepository } from '@app/common';
import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { EntityManager, Repository } from 'typeorm';
import { Lap } from './entities/lap.entity';

@Injectable()
export class LapsRepository extends AbstractRepository<Lap> {
  protected readonly logger: Logger = new Logger(LapsRepository.name);

  constructor(
    @InjectRepository(Lap)
    private readonly lapsRepository: Repository<Lap>,
    entityManager: EntityManager,
  ) {
    super(lapsRepository, entityManager);
  }

  findBySession(sessionId: string): Promise<Lap[]> {
    return this.lapsRepository.find({
      where: { sessionId },
      order: { lapNumber: 'ASC' },
    });
  }

  findOneByNumber(sessionId: string, lapNumber: number): Promise<Lap | null> {
    return this.lapsRepository.findOne({ where: { sessionId, lapNumber } });
  }

  /**
   * Write a freshly derived set of laps, tolerating a concurrent writer.
   *
   * Two tabs opening the same just-finished session both see `analyzedAt` null
   * and both derive it. They derive the *same* laps — the inputs are identical
   * and the derivation is deterministic — so the loser's rows are redundant
   * rather than wrong, and the unique index on `(sessionId, lapNumber)` turns
   * them into no-ops.
   *
   * `orIgnore` rather than a lock or a transaction, deliberately: the failure
   * being defended against is duplicate work, not corruption, and a lock held
   * across a segmentation pass over 24 000 samples would make the second reader
   * wait for the first instead of just losing a race it does not care about.
   */
  async insertIgnoringDuplicates(laps: Lap[]): Promise<void> {
    if (!laps.length) {
      return;
    }

    await this.lapsRepository
      .createQueryBuilder()
      .insert()
      .into(Lap)
      .values(laps)
      .orIgnore()
      .execute();
  }

  /**
   * Swap a session's laps for a freshly derived set, atomically.
   *
   * One transaction rather than a delete followed by an insert, because the two
   * are not independent: a recompute that cleared the rows first would leave
   * every concurrent reader looking at a session with no laps for the length of
   * the write, and would lose them outright if the insert failed. The caller
   * only reaches this once it *has* the replacement rows — see
   * `AnalysisService.recompute`.
   *
   * `orIgnore` for the same reason `insertIgnoringDuplicates` uses it: a plain
   * first read may be deriving the same session concurrently, and its rows are
   * redundant rather than wrong.
   */
  async replaceSession(sessionId: string, laps: Lap[]): Promise<void> {
    await this.lapsRepository.manager.transaction(async (manager) => {
      await manager.delete(Lap, { sessionId });

      if (!laps.length) {
        return;
      }

      await manager
        .createQueryBuilder()
        .insert()
        .into(Lap)
        .values(laps)
        .orIgnore()
        .execute();
    });
  }
}
