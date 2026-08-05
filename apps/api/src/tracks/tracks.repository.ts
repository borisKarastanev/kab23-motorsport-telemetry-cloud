import { AbstractRepository } from '@app/common';
import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { EntityManager, Repository } from 'typeorm';
import { Track } from './entities/track.entity';
import { TrackSeed } from './tracks.seed';

@Injectable()
export class TracksRepository extends AbstractRepository<Track> {
  protected readonly logger: Logger = new Logger(TracksRepository.name);

  constructor(
    @InjectRepository(Track)
    private readonly tracksRepository: Repository<Track>,
    entityManager: EntityManager,
  ) {
    super(tracksRepository, entityManager);
  }

  findAllOrdered(): Promise<Track[]> {
    return this.tracksRepository.find({ order: { name: 'ASC' } });
  }

  /**
   * The track a device's free-text `track` string denotes, or null.
   *
   * Matches a slug case-insensitively **or** one of the ids the on-car database
   * uses, because the two producers spell it differently: the mock publisher
   * sends `kaloyanovo`, the dash sends `52a619159ac25e7d6beb0e53`. Accepting
   * both here is what keeps `Session.track` free text, which
   * `SessionEventDto` requires it to be.
   *
   * Null rather than a throw: a car reporting a track this platform has never
   * heard of is an expected state, not an error.
   */
  findByDeviceTrack(track: string): Promise<Track | null> {
    return this.tracksRepository
      .createQueryBuilder('track')
      .where('lower(track.slug) = lower(:track)', { track })
      .orWhere(':track = ANY(track.deviceTrackIds)', { track })
      .getOne();
  }

  /**
   * Insert the seed rows, or bring existing ones back into line with it.
   *
   * Upsert rather than insert-if-absent, and the direction matters: the seed is
   * the single source of truth, so a gate corrected in the code must reach
   * databases that already hold the old one. That is safe only because there is
   * no API write path to clobber — see `Track`. If tracks ever become editable,
   * this has to become insert-if-absent, or a restart will silently discard
   * every correction a user made.
   */
  async upsertSeeds(seeds: TrackSeed[]): Promise<void> {
    await this.tracksRepository.upsert(seeds, { conflictPaths: ['slug'] });
  }
}
