import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * `track_maps`: one circuit outline per track, fetched from OpenStreetMap and
 * cached forever. See
 * `apps/api/src/tracks/track-map/entities/track-map.entity.ts` for why this
 * is a separate table from `tracks` rather than columns on it.
 *
 * Generated with `migration:generate` against a running database, not
 * hand-written — the `REL_…` unique constraint on `trackId` comes from the
 * entity's `@OneToOne` relation, and matching its name by hand risks a
 * spurious diff the next time this migration is regenerated from scratch.
 */
export class TrackMaps1786541926644 implements MigrationInterface {
  name = 'TrackMaps1786541926644';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TYPE "public"."track_maps_status_enum" AS ENUM('ready', 'unavailable')`,
    );
    await queryRunner.query(
      `CREATE TABLE "track_maps" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "updatedAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "trackId" uuid NOT NULL, "status" "public"."track_maps_status_enum" NOT NULL, "geojson" jsonb, "bboxMinLat" double precision, "bboxMinLon" double precision, "bboxMaxLat" double precision, "bboxMaxLon" double precision, "centrelineLengthM" double precision, "source" text NOT NULL DEFAULT 'overpass', "attribution" text, "osmDataTimestamp" TIMESTAMP WITH TIME ZONE, "fetchedAt" TIMESTAMP WITH TIME ZONE NOT NULL, "failureReason" text, CONSTRAINT "REL_9b2a046198da62fcfcb1d812c9" UNIQUE ("trackId"), CONSTRAINT "PK_55cd50bf9066766a7a76c65c046" PRIMARY KEY ("id"))`,
    );
    await queryRunner.query(
      `ALTER TABLE "track_maps" ADD CONSTRAINT "FK_9b2a046198da62fcfcb1d812c9e" FOREIGN KEY ("trackId") REFERENCES "tracks"("id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "track_maps" DROP CONSTRAINT "FK_9b2a046198da62fcfcb1d812c9e"`,
    );
    await queryRunner.query(`DROP TABLE "track_maps"`);
    await queryRunner.query(`DROP TYPE "public"."track_maps_status_enum"`);
  }
}
