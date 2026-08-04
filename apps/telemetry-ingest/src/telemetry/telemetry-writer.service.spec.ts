import { DataSource } from 'typeorm';
import { TelemetryWriterService } from './telemetry-writer.service';
import { TelemetrySample } from './entities/telemetry-sample.entity';

const sample = (seq: number): TelemetrySample => {
  const row = new TelemetrySample();
  row.time = new Date(Date.UTC(2026, 7, 1, 10, 0, seq));
  row.sessionId = '22222222-2222-4222-8222-222222222222';
  row.carId = '33333333-3333-4333-8333-333333333333';
  row.seq = seq;
  return row;
};

describe('TelemetryWriterService', () => {
  let service: TelemetryWriterService;
  let values: jest.Mock;
  let execute: jest.Mock;
  let orIgnore: jest.Mock;

  beforeEach(() => {
    execute = jest.fn().mockResolvedValue(undefined);
    orIgnore = jest.fn();
    const builder: Record<string, unknown> = {};
    values = jest.fn(() => builder);
    Object.assign(builder, {
      insert: () => builder,
      into: () => builder,
      values,
      orIgnore: orIgnore.mockReturnValue(builder),
      execute,
    });

    service = new TelemetryWriterService({
      createQueryBuilder: () => builder,
    } as unknown as DataSource);
  });

  const written = (call = 0): TelemetrySample[] =>
    values.mock.calls[call][0] as TelemetrySample[];

  it('writes with ON CONFLICT DO NOTHING so a replayed batch is free', async () => {
    // The device re-sends any batch it is not certain landed; duplicates have
    // to cost nothing, because losing data costs everything.
    service.enqueue(sample(1));
    await service.flush();

    expect(orIgnore).toHaveBeenCalled();
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it('flushes on its own once the row threshold is reached', async () => {
    for (let seq = 1; seq <= 100; seq += 1) {
      service.enqueue(sample(seq));
    }
    await service.flush();

    expect(execute).toHaveBeenCalledTimes(1);
    expect(written()).toHaveLength(100);
  });

  it('coalesces rather than writing one row per frame', async () => {
    for (let seq = 1; seq <= 30; seq += 1) {
      service.enqueue(sample(seq));
    }
    await service.flush();

    expect(execute).toHaveBeenCalledTimes(1);
    expect(written()).toHaveLength(30);
  });

  it('flushes a partial buffer once it goes stale', async () => {
    jest.useFakeTimers();
    try {
      service.enqueue(sample(1));
      expect(execute).not.toHaveBeenCalled();

      await jest.advanceTimersByTimeAsync(250);

      expect(execute).toHaveBeenCalledTimes(1);
    } finally {
      jest.useRealTimers();
    }
  });

  it('flushes what it is holding on shutdown', async () => {
    service.enqueue(sample(1));
    service.enqueue(sample(2));

    await service.onApplicationShutdown();

    expect(written()).toHaveLength(2);
  });

  it('never writes the same buffered rows twice', async () => {
    service.enqueue(sample(1));
    await service.flush();
    await service.flush();

    expect(execute).toHaveBeenCalledTimes(1);
  });

  it('keeps accepting frames after a failed write', async () => {
    // A database blip must not take the ingest process down with it — the
    // device is still publishing either way.
    execute.mockRejectedValueOnce(new Error('connection reset'));
    service.enqueue(sample(1));
    await service.flush();

    service.enqueue(sample(2));
    await service.flush();

    expect(execute).toHaveBeenCalledTimes(2);
    expect(written(1)).toHaveLength(1);
  });
});
