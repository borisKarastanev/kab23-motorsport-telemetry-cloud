import { config as loadEnv } from 'dotenv';
import * as Joi from 'joi';
import { DataSource, DataSourceOptions } from 'typeorm';
// Relative, unlike ConfigModule's bare `from 'config.schema'`: that one relies
// on tsconfig `baseUrl`, which webpack resolves for the Nest builds but plain
// `tsc` output does not — the emitted require() would fail at runtime.
import { configValidationSchema } from './config.schema';

/**
 * The DataSource the TypeORM **CLI** uses. Not the one the apps run on — that
 * one is built by `DatabaseModule` from `ConfigService`.
 *
 * Lives at the repo root next to `config.schema.ts`, following the same rule:
 * root-level config is not in `libs/`, because `libs/common` must never be the
 * thing that knows about `apps/*` entity layout.
 *
 * ### Why this reads `process.env` instead of `ConfigService`
 *
 * There is no Nest application here — the CLI invokes this file directly. Rather
 * than duplicating the validation, the DB keys are **extracted from the shared
 * Joi schema**, so a change to `DB_PORT`'s rules in `config.schema.ts` applies
 * here too.
 *
 * Only the DB subset is validated, deliberately. Validating the whole schema
 * would make the migration runner require `MQTT_USERNAME`/`MQTT_PASSWORD` —
 * handing broker credentials to a container that only ever runs DDL, which is
 * the same widening `docker-compose.yaml` already refuses when it blanks
 * `MQTT_ADMIN_*` for telemetry-ingest.
 */
loadEnv();

const databaseSchema = Joi.object({
  DB_HOST: configValidationSchema.extract('DB_HOST'),
  DB_PORT: configValidationSchema.extract('DB_PORT'),
  DB_USERNAME: configValidationSchema.extract('DB_USERNAME'),
  DB_PASSWORD: configValidationSchema.extract('DB_PASSWORD'),
  DB_DATABASE: configValidationSchema.extract('DB_DATABASE'),
}).unknown(true);

const env = Joi.attempt(process.env, databaseSchema, 'Migration config is invalid:');

/**
 * True when this file is running as compiled JavaScript — i.e. inside the
 * production image, where `tsconfig.migrations.json` has emitted it to
 * `dist/migrations/`. ts-node must not ship to a deployed box.
 */
const compiled = __filename.endsWith('.js');

export const dataSourceOptions: DataSourceOptions = {
  type: 'postgres',
  host: env.DB_HOST,
  port: env.DB_PORT,
  username: env.DB_USERNAME,
  password: env.DB_PASSWORD,
  database: env.DB_DATABASE,

  // The whole point of this file.
  synchronize: false,

  migrations: compiled
    ? [`${__dirname}/db/migrations/*.js`]
    : ['db/migrations/*.ts'],

  /**
   * Entities matter to `migration:generate`, which diffs them against the live
   * schema. `migration:run` does not *use* them, but it does still load them:
   * `DataSource.initialize()` calls `buildMetadatas()` unconditionally, so in
   * dev every run compiles these files and the `@app/common` barrel they pull
   * in — about a second of ts-node on top of its own startup. Tolerable for a
   * command run by hand.
   *
   * The compiled production build carries none, which is what keeps the migrate
   * container free of the app's `@app/common` path aliases and its whole import
   * graph — and makes `migration:run` there genuinely free.
   *
   * `apps/telemetry-ingest` is excluded on purpose. `CarRef`/`SessionRef` are
   * thin views of tables `apps/api` owns, and `TelemetrySample` is a hypertable
   * whose DDL is hand-written in the baseline migration. All three are already
   * `synchronize: false`, so this exclusion is belt and braces — but it also
   * means a future entity there can never silently start generating DDL.
   */
  entities: compiled ? [] : ['apps/api/**/*.entity.ts', 'libs/**/*.entity.ts'],
};

export default new DataSource(dataSourceOptions);
