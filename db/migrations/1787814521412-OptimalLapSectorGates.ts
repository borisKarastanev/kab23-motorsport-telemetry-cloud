import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Additive, touches no existing rows.
 *
 * `tracks.derivedSectorGates` is a separate column from `tracks.sectorGates`
 * on purpose — see the entity's own comment — so an auto-derived gate set is
 * never mistaken for a surveyed one, the same instinct as `track_maps`'
 * `unavailable` rows.
 *
 * `sessions.sectorScheme` is nullable and every existing row stays null:
 * that is exactly what a session analyzed under the old distance-fraction
 * fallback already is. No backfill, no `analyzedAt` reset — see
 * `AnalysisService` for how a null scheme is surfaced to the client rather
 * than hidden.
 */
export class OptimalLapSectorGates1787814521412 implements MigrationInterface {
  name = 'OptimalLapSectorGates1787814521412';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "tracks" ADD "derivedSectorGates" jsonb`,
    );
    await queryRunner.query(
      `ALTER TABLE "sessions" ADD "sectorScheme" text`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "sessions" DROP COLUMN "sectorScheme"`);
    await queryRunner.query(
      `ALTER TABLE "tracks" DROP COLUMN "derivedSectorGates"`,
    );
  }
}
