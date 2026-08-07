import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { EntityClassOrSchema } from '@nestjs/typeorm/dist/interfaces/entity-class-or-schema.type';
import { ConfigModule } from '../config/config.module';

/**
 * Single Postgres/TimescaleDB connection for the modular monolith.
 *
 * Unlike the multi-service reference (which hardcoded every app's entities
 * here), this stays generic: `autoLoadEntities` picks up whatever each feature
 * module registers via `DatabaseModule.forFeature([...])`, so libs/common never
 * has to import from apps/*.
 */
@Module({
  imports: [
    TypeOrmModule.forRootAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (configService: ConfigService) => ({
        type: 'postgres',
        host: configService.get<string>('DB_HOST'),
        port: configService.get<number>('DB_PORT'),
        username: configService.get<string>('DB_USERNAME'),
        password: configService.get<string>('DB_PASSWORD'),
        database: configService.get<string>('DB_DATABASE'),
        autoLoadEntities: true,

        /**
         * Off in development too, not just in production.
         *
         * Gating this on NODE_ENV is the obvious alternative and is worse: a
         * developer whose schema is maintained by `synchronize` never notices
         * the migration they forgot to generate, and the drift only surfaces on
         * the deployed box, where there is no `synchronize` to paper over it.
         * Migrations are the single source of schema truth everywhere.
         *
         * Run them with `pnpm run migration:run` (`pnpm run start:local` does
         * it for you); see typeorm.config.ts.
         */
        synchronize: false,
      }),
    }),
  ],
})
export class DatabaseModule {
  static forFeature(models: EntityClassOrSchema[]) {
    return TypeOrmModule.forFeature(models);
  }
}
