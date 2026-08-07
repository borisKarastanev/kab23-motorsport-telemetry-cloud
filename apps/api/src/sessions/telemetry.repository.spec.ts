import { DataSource } from 'typeorm';
import { TelemetryRepository } from './telemetry.repository';

describe('TelemetryRepository', () => {
  let dataSource: jest.Mocked<Partial<DataSource>>;
  let repository: TelemetryRepository;

  beforeEach(() => {
    dataSource = { query: jest.fn() };
    repository = new TelemetryRepository(
      dataSource as unknown as DataSource,
    );
  });

  it('returns whatever the query yields', async () => {
    const rows = [{ bucket: new Date(), rpm: 3200 }];
    (dataSource.query as jest.Mock).mockResolvedValue(rows);

    const from = new Date('2026-01-01T00:00:00Z');
    const to = new Date('2026-01-01T00:00:10Z');

    await expect(
      repository.findDownsampled('session-1', from, to, 11),
    ).resolves.toBe(rows);
  });

  it('sizes the bucket off maxPoints - 1, not maxPoints', async () => {
    (dataSource.query as jest.Mock).mockResolvedValue([]);

    const from = new Date('2026-01-01T00:00:00.000Z');
    const to = new Date('2026-01-01T00:00:10.000Z'); // 10s range

    await repository.findDownsampled('session-1', from, to, 11);

    const [, params] = (dataSource.query as jest.Mock).mock.calls[0];
    // 10s / (11 - 1) buckets = 1s per bucket.
    expect(params).toEqual([1, 'session-1', from, to]);
  });

  it('never sizes a bucket finer than the 10 Hz publish rate', async () => {
    (dataSource.query as jest.Mock).mockResolvedValue([]);

    const from = new Date('2026-01-01T00:00:00.000Z');
    const to = new Date('2026-01-01T00:00:00.050Z'); // 50ms range, far under 100ms

    await repository.findDownsampled('session-1', from, to, 500);

    const [, params] = (dataSource.query as jest.Mock).mock.calls[0];
    // Clamped to the 100ms floor, expressed in seconds.
    expect(params[0]).toBe(0.1);
  });

  it('treats a maxPoints of 1 as a single bucket rather than dividing by zero', async () => {
    (dataSource.query as jest.Mock).mockResolvedValue([]);

    const from = new Date('2026-01-01T00:00:00.000Z');
    const to = new Date('2026-01-01T00:00:05.000Z');

    await repository.findDownsampled('session-1', from, to, 1);

    const [, params] = (dataSource.query as jest.Mock).mock.calls[0];
    expect(params[0]).toBe(5);
  });
});
