import { Injectable } from '@nestjs/common';
import { TracksRepository } from './tracks.repository';
import { Track } from './entities/track.entity';
import { TrackMap } from './track-map/entities/track-map.entity';
import { TrackMapService } from './track-map/track-map.service';
import { PENDING } from './track-map/track-map.types';

/**
 * Reference data about circuits, and the S/F gate lap segmentation cuts on.
 *
 * **Deliberately performs no authorization.** Every other service in `apps/api`
 * scopes its reads to the caller's tenant; this one must not, because a track is
 * a surveyed fact about a place rather than anyone's data. See `Track` for the
 * full argument — the absence of a check here is a decision, not an oversight.
 */
@Injectable()
export class TracksService {
  constructor(
    private readonly tracksRepository: TracksRepository,
    private readonly trackMapService: TrackMapService,
  ) {}

  findAll(): Promise<Track[]> {
    return this.tracksRepository.findAllOrdered();
  }

  /**
   * Resolve a session's free-text `track` to a row, or null.
   *
   * Null is a first-class answer, not a failure: the on-car track database is
   * versioned independently of this platform, so a car may legitimately report a
   * track the cloud has never heard of. Phase 4's analysis pass treats that as
   * "no laps derived, reason `no-track-gate`" — never as an error, and never as
   * a licence to guess at where the line might be.
   */
  resolve(track?: string): Promise<Track | null> {
    if (!track?.trim()) {
      return Promise.resolve(null);
    }

    return this.tracksRepository.findByDeviceTrack(track.trim());
  }

  /**
   * The circuit outline `sector-gates.ts` derives a centreline gate set from.
   *
   * A thin pass-through to `TrackMapService` rather than exporting it from
   * `TracksModule` directly: `AnalysisService` already depends on this
   * service for `resolve`, and a second track-domain service in its
   * constructor would just be a second thing to keep in step with what a
   * "track" is.
   */
  getTrackMap(track: Track): Promise<TrackMap | typeof PENDING> {
    return this.trackMapService.get(track);
  }

  /** Persist a freshly derived sector gate set. See `TracksRepository`. */
  setDerivedSectorGates(
    trackId: string,
    derivedSectorGates: Track['derivedSectorGates'],
  ): Promise<void> {
    return this.tracksRepository.setDerivedSectorGates(
      trackId,
      derivedSectorGates,
    );
  }
}
