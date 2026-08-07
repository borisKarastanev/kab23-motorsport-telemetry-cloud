import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Schema baseline, cut at the end of Phase 4.
 *
 * Everything before this migration was created by TypeORM's `synchronize: true`,
 * which Phase 5 turns off (`libs/common/src/database/database.module.ts`). This
 * file is the first and last time the whole schema appears in one place: from
 * here on, every entity change gets its own generated migration.
 *
 * Three parts, in this order because each depends on the one before:
 *
 * 1. **Extensions.** `uuid-ossp` is easy to miss — `migration:generate` emits
 *    `uuid_generate_v4()` as the default for every `@PrimaryGeneratedColumn
 *    ('uuid')` but does *not* emit the extension that provides it, because
 *    `synchronize` used to create it as a side effect. Without this line the
 *    baseline fails on the first `CREATE TABLE` of a fresh database — which is
 *    to say, on the production box and nowhere else.
 * 2. **Domain tables**, generated from the entities under `apps/api`.
 * 3. **The telemetry hypertable**, hand-written. `migration:generate` cannot
 *    produce it: `TelemetrySample` is `synchronize: false` precisely because
 *    TypeORM knows nothing about `create_hypertable` and would recreate it as
 *    an ordinary table. This DDL moved here from
 *    `apps/telemetry-ingest/src/telemetry/telemetry-schema.service.ts`, which is
 *    now a boot-time existence check rather than a creator, so there is still
 *    exactly one copy of it.
 *
 * **`down()` drops everything, including every telemetry sample ever recorded.**
 * It is a real revert path for a bad *follow-up* migration during development.
 * It is not something to run against a box that has sessions on it, and there is
 * no undo — see DEPLOY.md for the restore-from-backup path instead.
 */
export class Baseline1786086655568 implements MigrationInterface {
  name = 'Baseline1786086655568';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // --- 1. Extensions -------------------------------------------------------
    // Idempotent, and duplicated by db/init/01-timescaledb.sql on a fresh
    // volume: that init script only ever runs against an empty data directory,
    // so it cannot be relied on for a database that already exists.
    await queryRunner.query(`CREATE EXTENSION IF NOT EXISTS timescaledb`);
    await queryRunner.query(`CREATE EXTENSION IF NOT EXISTS "uuid-ossp"`);

    // --- 2. Domain tables ----------------------------------------------------
    await queryRunner.query(
      `CREATE TYPE "public"."user_role_enum" AS ENUM('DRIVER', 'MANAGER', 'ADMIN')`,
    );
    await queryRunner.query(
      `CREATE TABLE "user" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "updatedAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "email" character varying NOT NULL, "password" character varying NOT NULL, "displayName" character varying, "role" "public"."user_role_enum" NOT NULL DEFAULT 'DRIVER', CONSTRAINT "UQ_e12875dfb3b1d92d7d7c5377e22" UNIQUE ("email"), CONSTRAINT "PK_cace4a159ff9f2512dd42373760" PRIMARY KEY ("id"))`,
    );
    await queryRunner.query(
      `CREATE TABLE "tracks" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "updatedAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "slug" character varying NOT NULL, "name" character varying NOT NULL, "country" character varying NOT NULL, "centreLat" double precision NOT NULL, "centreLon" double precision NOT NULL, "sfLat1" double precision NOT NULL, "sfLon1" double precision NOT NULL, "sfLat2" double precision NOT NULL, "sfLon2" double precision NOT NULL, "deviceTrackIds" text array NOT NULL DEFAULT '{}', "sectorGates" jsonb, CONSTRAINT "UQ_696107ffe87d837286180022495" UNIQUE ("slug"), CONSTRAINT "PK_242a37ffc7870380f0e611986e8" PRIMARY KEY ("id"))`,
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX "IDX_696107ffe87d83728618002249" ON "tracks" ("slug") `,
    );
    await queryRunner.query(
      `CREATE TYPE "public"."team_members_role_enum" AS ENUM('OWNER', 'MANAGER', 'DRIVER')`,
    );
    await queryRunner.query(
      `CREATE TABLE "team_members" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "updatedAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "teamId" uuid NOT NULL, "userId" uuid NOT NULL, "role" "public"."team_members_role_enum" NOT NULL DEFAULT 'DRIVER', CONSTRAINT "PK_ca3eae89dcf20c9fd95bf7460aa" PRIMARY KEY ("id"))`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_0a72b849753a046462b4c5a8ec" ON "team_members" ("userId") `,
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX "IDX_b2f17b533905e0a94390c5e220" ON "team_members" ("teamId", "userId") `,
    );
    await queryRunner.query(
      `CREATE TABLE "teams" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "updatedAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "name" character varying NOT NULL, CONSTRAINT "PK_7e5523774a38b08a6236d322403" PRIMARY KEY ("id"))`,
    );
    await queryRunner.query(
      `CREATE TYPE "public"."team_invites_role_enum" AS ENUM('OWNER', 'MANAGER', 'DRIVER')`,
    );
    await queryRunner.query(
      `CREATE TABLE "team_invites" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "updatedAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "teamId" uuid NOT NULL, "email" character varying NOT NULL, "role" "public"."team_invites_role_enum" NOT NULL DEFAULT 'DRIVER', CONSTRAINT "PK_2df756220f694d8f6cf5d0988ec" PRIMARY KEY ("id"))`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_5151c34eca76038b2aeebf36f2" ON "team_invites" ("email") `,
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX "IDX_b60a1e0058a0cb1846aa5e4c0e" ON "team_invites" ("teamId", "email") `,
    );
    await queryRunner.query(
      `CREATE TABLE "cars" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "updatedAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "name" character varying NOT NULL, "make" character varying, "model" character varying, "deviceId" character varying NOT NULL, "mqttProvisionedAt" TIMESTAMP WITH TIME ZONE, "ownerId" uuid NOT NULL, "teamId" uuid, CONSTRAINT "UQ_67029e7fba33e18e90956cf3514" UNIQUE ("deviceId"), CONSTRAINT "PK_fc218aa84e79b477d55322271b6" PRIMARY KEY ("id"))`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_20e9b841c845a35a7ff00f13a8" ON "cars" ("teamId") `,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_f011a88b8b052ffd0db75c1ad4" ON "cars" ("ownerId") `,
    );
    await queryRunner.query(
      `CREATE TYPE "public"."sessions_status_enum" AS ENUM('LIVE', 'COMPLETED', 'ABORTED')`,
    );
    await queryRunner.query(
      `CREATE TABLE "sessions" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "updatedAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "carId" uuid NOT NULL, "driverId" uuid NOT NULL, "track" character varying NOT NULL, "startedAt" TIMESTAMP WITH TIME ZONE NOT NULL, "endedAt" TIMESTAMP WITH TIME ZONE, "status" "public"."sessions_status_enum" NOT NULL DEFAULT 'LIVE', "deviceSessionId" uuid, "deviceMonoStartMs" bigint, "analyzedAt" TIMESTAMP WITH TIME ZONE, CONSTRAINT "UQ_ffcf8f279ff6982ef25dc9448e5" UNIQUE ("deviceSessionId"), CONSTRAINT "PK_3238ef96f18b355b671619111bc" PRIMARY KEY ("id"))`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_8198413e67ccc169c8caaf53c7" ON "sessions" ("driverId", "startedAt") `,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_431c8510f8fbead4eb54eb299d" ON "sessions" ("carId", "startedAt") `,
    );
    await queryRunner.query(
      `CREATE TABLE "laps" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "updatedAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "sessionId" uuid NOT NULL, "lapNumber" integer NOT NULL, "startedAt" TIMESTAMP WITH TIME ZONE NOT NULL, "endedAt" TIMESTAMP WITH TIME ZONE NOT NULL, "lapMs" integer NOT NULL, "distanceM" integer NOT NULL, "maxSpeedKmh" real, "minSpeedKmh" real, "sectorMs" integer array NOT NULL DEFAULT '{}', "brakingPoints" jsonb NOT NULL DEFAULT '[]', "isBest" boolean NOT NULL DEFAULT false, CONSTRAINT "PK_2ef05004e276318aa254bca4901" PRIMARY KEY ("id"))`,
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX "IDX_4d0e55a52a1ff03e50b7596843" ON "laps" ("sessionId", "lapNumber") `,
    );
    await queryRunner.query(
      `ALTER TABLE "team_members" ADD CONSTRAINT "FK_6d1c8c7f705803f0711336a5c33" FOREIGN KEY ("teamId") REFERENCES "teams"("id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "team_members" ADD CONSTRAINT "FK_0a72b849753a046462b4c5a8ec2" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "team_invites" ADD CONSTRAINT "FK_79cc18d8efe27b7d57df31c187a" FOREIGN KEY ("teamId") REFERENCES "teams"("id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "cars" ADD CONSTRAINT "FK_f011a88b8b052ffd0db75c1ad44" FOREIGN KEY ("ownerId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "cars" ADD CONSTRAINT "FK_20e9b841c845a35a7ff00f13a89" FOREIGN KEY ("teamId") REFERENCES "teams"("id") ON DELETE SET NULL ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "sessions" ADD CONSTRAINT "FK_cf3ce153cc1789909e93ca195cd" FOREIGN KEY ("carId") REFERENCES "cars"("id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "sessions" ADD CONSTRAINT "FK_7c1f7a3be4c5d4536d9e4ce3c60" FOREIGN KEY ("driverId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "laps" ADD CONSTRAINT "FK_ed828a32a0d3e9534ea55f44196" FOREIGN KEY ("sessionId") REFERENCES "sessions"("id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );

    // --- 3. Telemetry hypertable ---------------------------------------------
    //
    // Deliberately carries no foreign key to `sessions` or `cars`. A hypertable
    // taking 10 rows/second/car should not pay for a referential check on every
    // insert, and ingest already resolves both ids before it writes.
    await queryRunner.query(`CREATE TABLE "telemetry_samples" (
       time        TIMESTAMPTZ      NOT NULL,
       session_id  UUID             NOT NULL,
       seq         BIGINT           NOT NULL,
       car_id      UUID             NOT NULL,
       rpm         INTEGER,
       coolant_c   REAL,
       oil_c       REAL,
       speed_kmh   REAL,
       lat         DOUBLE PRECISION,
       lon         DOUBLE PRECISION,
       g_lat       REAL,
       g_lon       REAL,
       g_vert      REAL,
       lap_number  INTEGER,
       lap_ms      INTEGER,
       ext         JSONB
     )`);

    await queryRunner.query(
      `SELECT create_hypertable('telemetry_samples', 'time',
         chunk_time_interval => INTERVAL '1 day',
         if_not_exists => TRUE)`,
    );

    // Timescale requires the partitioning column in every unique index, which is
    // why this is `(session_id, seq, time)` and not `(session_id, seq)`. It
    // still dedupes exactly: `time` is derived deterministically from the
    // session's anchor plus the frame's monotonic counter, so the same frame
    // always lands on the same timestamp. That is what makes a device re-sending
    // an unacknowledged backfill batch free.
    await queryRunner.query(
      `CREATE UNIQUE INDEX "telemetry_samples_dedup"
         ON "telemetry_samples" (session_id, seq, time)`,
    );
    await queryRunner.query(
      `CREATE INDEX "telemetry_samples_session_time"
         ON "telemetry_samples" (session_id, time DESC)`,
    );
    await queryRunner.query(
      `CREATE INDEX "telemetry_samples_car_time"
         ON "telemetry_samples" (car_id, time DESC)`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // Destroys every recorded sample. See the class docblock.
    await queryRunner.query(`DROP TABLE IF EXISTS "telemetry_samples"`);

    await queryRunner.query(
      `ALTER TABLE "laps" DROP CONSTRAINT "FK_ed828a32a0d3e9534ea55f44196"`,
    );
    await queryRunner.query(
      `ALTER TABLE "sessions" DROP CONSTRAINT "FK_7c1f7a3be4c5d4536d9e4ce3c60"`,
    );
    await queryRunner.query(
      `ALTER TABLE "sessions" DROP CONSTRAINT "FK_cf3ce153cc1789909e93ca195cd"`,
    );
    await queryRunner.query(
      `ALTER TABLE "cars" DROP CONSTRAINT "FK_20e9b841c845a35a7ff00f13a89"`,
    );
    await queryRunner.query(
      `ALTER TABLE "cars" DROP CONSTRAINT "FK_f011a88b8b052ffd0db75c1ad44"`,
    );
    await queryRunner.query(
      `ALTER TABLE "team_invites" DROP CONSTRAINT "FK_79cc18d8efe27b7d57df31c187a"`,
    );
    await queryRunner.query(
      `ALTER TABLE "team_members" DROP CONSTRAINT "FK_0a72b849753a046462b4c5a8ec2"`,
    );
    await queryRunner.query(
      `ALTER TABLE "team_members" DROP CONSTRAINT "FK_6d1c8c7f705803f0711336a5c33"`,
    );
    await queryRunner.query(`DROP INDEX "public"."IDX_4d0e55a52a1ff03e50b7596843"`);
    await queryRunner.query(`DROP TABLE "laps"`);
    await queryRunner.query(`DROP INDEX "public"."IDX_431c8510f8fbead4eb54eb299d"`);
    await queryRunner.query(`DROP INDEX "public"."IDX_8198413e67ccc169c8caaf53c7"`);
    await queryRunner.query(`DROP TABLE "sessions"`);
    await queryRunner.query(`DROP TYPE "public"."sessions_status_enum"`);
    await queryRunner.query(`DROP INDEX "public"."IDX_f011a88b8b052ffd0db75c1ad4"`);
    await queryRunner.query(`DROP INDEX "public"."IDX_20e9b841c845a35a7ff00f13a8"`);
    await queryRunner.query(`DROP TABLE "cars"`);
    await queryRunner.query(`DROP INDEX "public"."IDX_b60a1e0058a0cb1846aa5e4c0e"`);
    await queryRunner.query(`DROP INDEX "public"."IDX_5151c34eca76038b2aeebf36f2"`);
    await queryRunner.query(`DROP TABLE "team_invites"`);
    await queryRunner.query(`DROP TYPE "public"."team_invites_role_enum"`);
    await queryRunner.query(`DROP TABLE "teams"`);
    await queryRunner.query(`DROP INDEX "public"."IDX_b2f17b533905e0a94390c5e220"`);
    await queryRunner.query(`DROP INDEX "public"."IDX_0a72b849753a046462b4c5a8ec"`);
    await queryRunner.query(`DROP TABLE "team_members"`);
    await queryRunner.query(`DROP TYPE "public"."team_members_role_enum"`);
    await queryRunner.query(`DROP INDEX "public"."IDX_696107ffe87d83728618002249"`);
    await queryRunner.query(`DROP TABLE "tracks"`);
    await queryRunner.query(`DROP TABLE "user"`);
    await queryRunner.query(`DROP TYPE "public"."user_role_enum"`);
  }
}
