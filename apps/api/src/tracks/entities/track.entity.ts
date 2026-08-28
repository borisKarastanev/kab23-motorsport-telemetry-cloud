import { AbstractEntity } from '@app/common';
import { Column, Entity, Index } from 'typeorm';

/**
 * A circuit and, crucially, its start/finish gate — the line lap segmentation
 * cuts on.
 *
 * **Reference data, not tenant data.** Unlike every other entity in `apps/api`,
 * a track belongs to nobody: it is a surveyed fact about a place, the same for
 * every team, and reading one reveals nothing about anyone. That is why there is
 * no `ownerId`/`teamId` here and no scoping in `TracksService` — and it is worth
 * stating explicitly, because "no authorization check" is otherwise exactly the
 * bug this codebase works hardest to avoid.
 *
 * Rows are seeded from a committed constant (`tracks.seed.ts`) by
 * `TracksSeedService`, and there is no write path through the API.
 */
@Entity('tracks')
// The lookup `IngestSessionsService`'s `track` string resolves through, on every
// analysis run.
@Index(['slug'], { unique: true })
export class Track extends AbstractEntity<Track> {
  /** Stable, human-readable key. What the mock publisher reports. */
  @Column({ unique: true })
  slug: string;

  @Column()
  name: string;

  @Column()
  country: string;

  /** Map centring only — never used for segmentation. */
  @Column({ type: 'double precision' })
  centreLat: number;

  @Column({ type: 'double precision' })
  centreLon: number;

  /**
   * The start/finish gate, as two endpoints spanning the track.
   *
   * Four columns rather than a JSON blob because these are the numbers the
   * crossing maths reads on every sample of every lap, and because a null or a
   * missing key in a blob would surface as a silently un-segmentable session
   * rather than as a schema error.
   *
   * Copied from the on-car dash's track database, where the equivalent field is
   * a flat `[lat1, lon1, lat2, lon2]` array — see `tracks.seed.ts` for
   * provenance.
   */
  @Column({ type: 'double precision' })
  sfLat1: number;

  @Column({ type: 'double precision' })
  sfLon1: number;

  @Column({ type: 'double precision' })
  sfLat2: number;

  @Column({ type: 'double precision' })
  sfLon2: number;

  /**
   * The identifiers the on-car dash knows this track by.
   *
   * A device reports whatever its own track database calls the track — an
   * opaque id like `52a619159ac25e7d6beb0e53`, not our slug. `SessionEventDto`
   * keeps `track` as free text precisely because that database is versioned
   * independently of this platform, so the cloud cannot assume the two agree.
   * This column is what lets both spellings resolve to one row without turning
   * `Session.track` into a foreign key it must not be.
   */
  @Column({ type: 'text', array: true, default: () => "'{}'" })
  deviceTrackIds: string[];

  /**
   * Split-point gates, when someone has real ones, in the same endpoint shape
   * as the S/F gate above.
   *
   * Null for every track today, and deliberately so: no track database carries
   * split points, and inventing coordinates would be worse than the honest
   * fallback of splitting a lap into equal distance fractions. Declared now
   * rather than added later only because Phase 5 cuts the migration baseline
   * once Phase 4's entities settle, and a nullable column costs nothing to
   * carry into it. The segmenter reads gates when present and falls back to
   * fractions when not.
   */
  @Column({ type: 'jsonb', nullable: true })
  sectorGates?: { lat1: number; lon1: number; lat2: number; lon2: number }[];

  /**
   * Split-point gates this platform derived itself, when nobody surveyed real
   * ones — from the OSM centreline when `track_maps` has one, or from a
   * session's own best lap otherwise. Separate from `sectorGates` above so an
   * auto-derived gate is never mistaken for a surveyed one: `sectorGates` is
   * authoritative and never overwritten, this column is a cache the next
   * derivation for this track can just read.
   *
   * Null for every track until the first session at it is analyzed —
   * `sector-gates.ts` populates it and `derivedAt` records when.
   */
  @Column({ type: 'jsonb', nullable: true })
  derivedSectorGates?: {
    gates: { lat1: number; lon1: number; lat2: number; lon2: number }[];
    source: 'centreline' | 'reference-lap';
    derivedAt: string;
  };
}
