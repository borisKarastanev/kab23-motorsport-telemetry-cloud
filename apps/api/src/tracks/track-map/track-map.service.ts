import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Track } from '../entities/track.entity';
import { OverpassClient } from './overpass.client';
import { TrackMapGate, buildTrackMap } from './track-map.builder';
import { TrackMapRepository } from './track-map.repository';
import { TrackMap, TrackMapStatus } from './entities/track-map.entity';
import { PENDING } from './track-map.types';

const DEFAULT_ATTRIBUTION = 'Map data © OpenStreetMap contributors, ODbL 1.0';

/**
 * Races `promise` against a deadline, resolving `undefined` on timeout.
 *
 * `promise` itself is never cancelled — the caller decides what "the loser
 * keeps running in the background" means. What this must not do is leave the
 * deadline's own `setTimeout` pending: without the `clearTimeout` here, every
 * call that wins on `promise` still leaves an `ms`-long timer alive and
 * referenced, which is a real handle Node holds the process open for — not
 * just untidy, but the actual reason a background fetch that already lost the
 * race must never spawn one of these per attempt.
 */
function withDeadline<T>(
  promise: Promise<T>,
  ms: number,
): Promise<T | undefined> {
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<undefined>((resolve) => {
    timer = setTimeout(() => resolve(undefined), ms);
  });

  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/** A track this platform is still fetching a circuit outline for. */

/**
 * A circuit's outline, fetched from OpenStreetMap once and cached forever.
 *
 * **Never breaks the view it decorates.** Same discipline as
 * `LivePublisherService.publishFrame` on the live path: every failure — a
 * network error, a malformed Overpass response, a ring that will not stitch
 * or does not sit under the track's own gate — is caught, logged, and turned
 * into a persisted `unavailable` row rather than thrown. A racing line has to
 * render whether or not a third-party API is reachable.
 *
 * **Lazy and once, like `AnalysisService`'s derivation.** The first request
 * for a track's map fetches and persists it; every later one is a plain
 * select. Unlike derivation, a fetch that is slow rather than wrong is
 * handled by racing it against `TRACK_MAP_FETCH_DEADLINE_MS`: the caller gets
 * `PENDING` if Overpass has not answered in time, and the fetch keeps running
 * in the background and persists whenever it does finish — the next request
 * for the same track then finds it cached.
 */
@Injectable()
export class TrackMapService {
  private readonly logger = new Logger(TrackMapService.name);

  /**
   * Single-flight per track.
   *
   * In-process only, same caveat as `AnalysisService.noCrossings`: a second
   * API instance can still race this one to fetch the same cold track. The
   * unique index on `trackId` plus `TrackMapRepository.save`'s upsert is what
   * makes that race harmless rather than a duplicate-row error.
   */
  private readonly inflight = new Map<string, Promise<TrackMap>>();

  constructor(
    private readonly config: ConfigService,
    private readonly overpassClient: OverpassClient,
    private readonly trackMapRepository: TrackMapRepository,
  ) {}

  /**
   * The cached map for a track, `PENDING` if a fetch is now underway and has
   * not answered within the deadline, or an `unavailable` row explaining why
   * there is nothing to show.
   */
  async get(track: Track): Promise<TrackMap | typeof PENDING> {
    const existing = await this.trackMapRepository.findByTrackId(track.id);
    if (existing && !this.isStaleUnavailable(existing)) {
      return existing;
    }

    if (!this.fetchEnabled()) {
      return existing ?? this.unavailableWithoutFetching(track.id);
    }

    const fetching = this.fetchOrJoin(track);
    const deadlineMs = this.config.get<number>('TRACK_MAP_FETCH_DEADLINE_MS')!;

    // `fetching` is not cancelled on a timeout — it keeps running and
    // persists whenever it finishes, so the next request for this track
    // finds it cached even though this one answered PENDING.
    const winner = await withDeadline(fetching, deadlineMs);
    return winner ?? PENDING;
  }

  private fetchEnabled(): boolean {
    const enabled = this.config.get<boolean>('TRACK_MAP_FETCH_ENABLED');
    return enabled !== false;
  }

  /**
   * An `unavailable` answer for a track nothing has tried yet.
   *
   * Returned but deliberately **not persisted** — persisting it would
   * seed a permanent `unavailable` row for a track this deployment simply has
   * not tried yet, so re-enabling `TRACK_MAP_FETCH_ENABLED` would still see
   * it as cached and never fetch. Only a real, dated attempt is worth caching.
   */
  private unavailableWithoutFetching(trackId: string): TrackMap {
    return new TrackMap({
      trackId,
      status: TrackMapStatus.UNAVAILABLE,
      fetchedAt: new Date(),
      failureReason: 'fetch-disabled',
    });
  }

  /**
   * An `unavailable` row is left alone for `TRACK_MAP_RETRY_AFTER_HOURS`
   * before the next request is allowed to try Overpass again — otherwise a
   * track this platform simply cannot place (no OSM coverage, a gate that
   * does not match anything mapped) fires a query on every page load.
   */
  private isStaleUnavailable(row: TrackMap): boolean {
    if (row.status !== TrackMapStatus.UNAVAILABLE) {
      return false;
    }

    const retryAfterHours = this.config.get<number>(
      'TRACK_MAP_RETRY_AFTER_HOURS',
    )!;
    const ageMs = Date.now() - row.fetchedAt.getTime();
    return ageMs > retryAfterHours * 3_600_000;
  }

  private fetchOrJoin(track: Track): Promise<TrackMap> {
    const existing = this.inflight.get(track.id);
    if (existing) {
      return existing;
    }

    const promise = this.fetchAndPersist(track).finally(() =>
      this.inflight.delete(track.id),
    );
    this.inflight.set(track.id, promise);
    return promise;
  }

  private async fetchAndPersist(track: Track): Promise<TrackMap> {
    try {
      const response = await this.overpassClient.fetchRaceways(
        track.centreLat,
        track.centreLon,
      );
      const outcome = buildTrackMap(response, gateOf(track));

      if (outcome.outcome === 'rejected') {
        this.logger.warn(
          `Track map unavailable for ${track.slug}: ${outcome.reason}`,
        );
        return this.trackMapRepository.save(
          new TrackMap({
            trackId: track.id,
            status: TrackMapStatus.UNAVAILABLE,
            fetchedAt: new Date(),
            failureReason: outcome.reason,
          }),
        );
      }

      return this.trackMapRepository.save(
        new TrackMap({
          trackId: track.id,
          status: TrackMapStatus.READY,
          geojson: outcome.geojson,
          bboxMinLat: outcome.bbox.minLat,
          bboxMinLon: outcome.bbox.minLon,
          bboxMaxLat: outcome.bbox.maxLat,
          bboxMaxLon: outcome.bbox.maxLon,
          centrelineLengthM: outcome.centrelineLengthM,
          source: 'overpass',
          attribution: response.osm3s?.copyright ?? DEFAULT_ATTRIBUTION,
          osmDataTimestamp: outcome.osmDataTimestamp ?? undefined,
          fetchedAt: new Date(),
        }),
      );
    } catch (error) {
      // A network failure, a malformed response, or Overpass itself being
      // down — none of it may propagate to the caller. See the class
      // docblock: this is a cache and a convenience, never a dependency a
      // racing line can fail to render over.
      //
      // The message is logged but **never stored or returned**: `failureReason`
      // reaches any authenticated client through `toTrackMapResponseDto`, and a
      // raw fetch error carries internal network detail —
      // `getaddrinfo EAI_AGAIN overpass-api.de`, or behind an egress proxy
      // `connect ECONNREFUSED 10.0.0.5:3128`, which discloses topology. Same
      // rule CLAUDE.md states for exceptions: log the cause, return a constant.
      this.logger.warn(
        `Track map fetch failed for ${track.slug}: ${(error as Error).message}`,
      );
      return this.trackMapRepository.save(
        new TrackMap({
          trackId: track.id,
          status: TrackMapStatus.UNAVAILABLE,
          fetchedAt: new Date(),
          failureReason: 'fetch-failed',
        }),
      );
    }
  }
}

const gateOf = (track: Track): TrackMapGate => ({
  lat1: track.sfLat1,
  lon1: track.sfLon1,
  lat2: track.sfLat2,
  lon2: track.sfLon2,
});
