import { DataSource } from 'typeorm';
import { TelemetrySchemaGuard } from './telemetry-schema.guard';

describe('TelemetrySchemaGuard', () => {
  const guardOver = (rows: unknown) => {
    const query = jest.fn().mockResolvedValue(rows);
    return {
      guard: new TelemetrySchemaGuard({ query } as unknown as DataSource),
      query,
    };
  };

  /**
   * The `timescaledb_information.hypertables` assertion is the point, not an
   * incidental detail: a plain table of the right shape accepts every insert and
   * looks healthy while silently giving up chunking, compression and the
   * time-series query plans the analysis endpoints assume. `to_regclass` would
   * not catch that, so "the table exists" is not the question worth asking.
   */
  it('starts when the hypertable is registered with Timescale', async () => {
    const { guard, query } = guardOver([{ '?column?': 1 }]);

    await expect(guard.onModuleInit()).resolves.toBeUndefined();
    expect(query).toHaveBeenCalledWith(expect.any(String), [
      'telemetry_samples',
    ]);
    expect(query.mock.calls[0][0]).toContain(
      'timescaledb_information.hypertables',
    );
  });

  it('refuses to start when the migration has not been run', async () => {
    const { guard } = guardOver([]);

    // The message has to name the fix: this fires on a deploy, in front of
    // somebody who is not looking at this file.
    await expect(guard.onModuleInit()).rejects.toThrow(/migration:run/);
  });
});
