import { AbstractRepository } from '@app/common';
import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { EntityManager, Repository } from 'typeorm';
import { TrackMap } from './entities/track-map.entity';

@Injectable()
export class TrackMapRepository extends AbstractRepository<TrackMap> {
  protected readonly logger: Logger = new Logger(TrackMapRepository.name);

  constructor(
    @InjectRepository(TrackMap)
    private readonly trackMapRepository: Repository<TrackMap>,
    entityManager: EntityManager,
  ) {
    super(trackMapRepository, entityManager);
  }

  /**
   * The cached row for a track, or null.
   *
   * Not `AbstractRepository.findOne` — that throws `NotFoundException`, which
   * is right for "this id must exist" lookups and wrong here: a track with no
   * `track_maps` row yet is the ordinary, expected state for the very first
   * request `TrackMapService` ever sees for it, not a failure.
   */
  findByTrackId(trackId: string): Promise<TrackMap | null> {
    return this.trackMapRepository.findOne({ where: { trackId } });
  }

  /**
   * Insert-or-replace, keyed on `trackId`.
   *
   * `upsert` rather than `create`/`findOneAndUpdate`: two API instances can
   * race to fetch the same cold track, and the unique index on `trackId` is
   * what makes the loser's write a harmless overwrite instead of a duplicate
   * row or an unhandled constraint violation. Whichever result lands last
   * wins, which is fine — both were built from the same Overpass query
   * against the same track.
   */
  async save(row: TrackMap): Promise<TrackMap> {
    await this.trackMapRepository.upsert(row, { conflictPaths: ['trackId'] });
    return this.trackMapRepository.findOneOrFail({
      where: { trackId: row.trackId },
    });
  }
}
