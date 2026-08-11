import { ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { TypeOrmModule } from '@nestjs/typeorm';
import { getDataSourceToken } from '@nestjs/typeorm';
import { DatabaseModule } from './database.module';

/**
 * The `TypeOrmModuleOptions` provider Nest builds from
 * `TypeOrmModule.forRootAsync`'s `useFactory`. Reached through module metadata
 * rather than exported from `DatabaseModule`, since the factory is otherwise
 * only reachable by actually opening a Postgres connection.
 */
const optionsFactory = (): ((
  config: ConfigService,
) => Record<string, unknown>) => {
  const imports: Array<{ module?: unknown; imports?: unknown[] }> =
    Reflect.getMetadata('imports', DatabaseModule);
  const typeOrmDynamicModule = imports.find(
    (imported) => imported.module === TypeOrmModule,
  ) as { imports: Array<{ providers: Array<Record<string, unknown>> }> };

  const provider = typeOrmDynamicModule.imports[0].providers.find(
    (candidate) => candidate.provide === 'TypeOrmModuleOptions',
  ) as { useFactory: (config: ConfigService) => Record<string, unknown> };

  return provider.useFactory;
};

describe('DatabaseModule', () => {
  it('compiles with the DataSource provider overridden', async () => {
    // The real DataSource provider's factory calls `dataSource.initialize()`
    // against actual Postgres, so it is swapped out here purely to prove the
    // module wires up without throwing — not to exercise a live connection.
    const moduleRef = await Test.createTestingModule({
      imports: [DatabaseModule],
    })
      .overrideProvider(getDataSourceToken())
      .useValue({})
      .compile();

    expect(moduleRef).toBeDefined();
  });

  it('forFeature delegates straight to TypeOrmModule.forFeature', () => {
    const dynamicModule = DatabaseModule.forFeature([]);

    expect(dynamicModule.module).toBe(TypeOrmModule);
  });

  it('builds postgres connection options from ConfigService and keeps synchronize off', () => {
    // `synchronize` gated on NODE_ENV was rejected deliberately (CLAUDE.md):
    // schema drift must surface identically in dev and prod, so this must stay
    // `false` regardless of what NODE_ENV the factory sees.
    const configService = {
      get: (key: string) =>
        ({
          DB_HOST: 'timescaledb',
          DB_PORT: 5432,
          DB_USERNAME: 'app',
          DB_PASSWORD: 'app-password',
          DB_DATABASE: 'telemetry',
          NODE_ENV: 'production',
        })[key],
    } as unknown as ConfigService;

    const options = optionsFactory()(configService);

    expect(options).toMatchObject({
      type: 'postgres',
      host: 'timescaledb',
      port: 5432,
      username: 'app',
      password: 'app-password',
      database: 'telemetry',
      autoLoadEntities: true,
      synchronize: false,
    });
  });
});
