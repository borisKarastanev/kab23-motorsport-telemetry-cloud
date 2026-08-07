import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { TracksRepository } from './tracks.repository';
import { TRACK_SEEDS } from './tracks.seed';

/**
 * Puts the reference tracks in the database on boot.
 *
 * **Not `db/init/`**: `docker-entrypoint-initdb.d` runs only against an empty
 * data directory, so every existing dev database would silently never get these
 * rows — and a second copy of the coordinates would drift from this one. (The
 * hypertable DDL was here for the same reason until Phase 5 moved it into the
 * baseline migration, which has no such limitation. Reference data stays on
 * boot: it is idempotent upserts, not schema.)
 *
 * Idempotent, so this is a no-op on all but the first boot and after a seed
 * edit. Phase 5 folds it into the migration baseline along with the rest of the
 * schema.
 *
 * Failure is logged, not thrown: the API serving every other endpoint is worth
 * more than the three rows that make lap segmentation available, and the next
 * restart retries. A missing track surfaces as `no-track-gate` on the analysis
 * endpoint, which is a state that path already handles.
 */
@Injectable()
export class TracksSeedService implements OnModuleInit {
  private readonly logger = new Logger(TracksSeedService.name);

  constructor(private readonly tracksRepository: TracksRepository) {}

  async onModuleInit(): Promise<void> {
    try {
      await this.tracksRepository.upsertSeeds(TRACK_SEEDS);
      this.logger.log(`Seeded ${TRACK_SEEDS.length} reference tracks`);
    } catch (error) {
      this.logger.error(
        `Could not seed reference tracks: ${(error as Error).message}`,
      );
    }
  }
}
