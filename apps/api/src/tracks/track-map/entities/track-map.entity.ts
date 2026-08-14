import { AbstractEntity } from '@app/common';
import { Column, Entity, JoinColumn, OneToOne } from 'typeorm';
import { Track } from '../../entities/track.entity';
import { TrackMapGeoJson } from '../track-map.types';

export enum TrackMapStatus {
  READY = 'ready',
  UNAVAILABLE = 'unavailable',
}

/**
 * A circuit's outline, fetched from OpenStreetMap once and cached forever.
 *
 * **A separate table from `Track`, deliberately.** `Track` is reference data
 * upserted from a committed constant on every boot and read by
 * `TracksRepository.findByDeviceTrack` on every analysis run; a 7–30 KB jsonb
 * blob does not belong on that hot row. This one has its own lifecycle — it is
 * *fetched*, it can fail, and `fetchedAt` is both a provenance stamp and the
 * cooldown clock on a failed fetch.
 *
 * One row per track — enforced by `@OneToOne` rather than a separate unique
 * index, which would otherwise duplicate the same constraint under a second
 * name. `status: 'unavailable'` is a first-class, expected state — a track
 * this platform cannot place on OpenStreetmap is exactly the kind of thing
 * `TracksService.resolve` already treats as ordinary rather than an error,
 * and `TrackMapService` follows the same stance. `geojson` and the derived
 * fields are null in that state; `failureReason` says why.
 */
@Entity('track_maps')
export class TrackMap extends AbstractEntity<TrackMap> {
  @Column({ type: 'uuid' })
  trackId: string;

  @OneToOne(() => Track, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'trackId' })
  track: Track;

  @Column({ type: 'enum', enum: TrackMapStatus })
  status: TrackMapStatus;

  /** One `role: 'circuit'` LineString plus N `role: 'corner'` ones. */
  @Column({ type: 'jsonb', nullable: true })
  geojson?: TrackMapGeoJson;

  @Column({ type: 'double precision', nullable: true })
  bboxMinLat?: number;

  @Column({ type: 'double precision', nullable: true })
  bboxMinLon?: number;

  @Column({ type: 'double precision', nullable: true })
  bboxMaxLat?: number;

  @Column({ type: 'double precision', nullable: true })
  bboxMaxLon?: number;

  @Column({ type: 'double precision', nullable: true })
  centrelineLengthM?: number;

  @Column({ type: 'text', default: 'overpass' })
  source: string;

  /** The ODbL notice, stored so the UI never has to hardcode attribution text. */
  @Column({ type: 'text', nullable: true })
  attribution?: string;

  /** From the Overpass response's `osm3s.timestamp_osm_base` — dates the data. */
  @Column({ type: 'timestamptz', nullable: true })
  osmDataTimestamp?: Date;

  /** When this row was last written. Also the `unavailable` retry cooldown. */
  @Column({ type: 'timestamptz' })
  fetchedAt: Date;

  @Column({ type: 'text', nullable: true })
  failureReason?: string;
}
