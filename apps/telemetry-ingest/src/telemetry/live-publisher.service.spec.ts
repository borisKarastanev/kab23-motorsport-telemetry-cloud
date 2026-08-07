import { LKV_TTL_SECONDS, REDIS_CLIENT, LiveFrame } from '@app/common';
import { Test } from '@nestjs/testing';
import { getMetadataArgsStorage } from 'typeorm';
import { LivePublisherService } from './live-publisher.service';
import { TelemetrySample } from './entities/telemetry-sample.entity';

const SESSION_ID = '22222222-2222-4222-8222-222222222222';
const CAR_ID = '33333333-3333-4333-8333-333333333333';
const SAMPLE_TIME = new Date('2026-08-01T10:00:04.000Z');

const sample = (overrides: Partial<TelemetrySample> = {}): TelemetrySample =>
  Object.assign(new TelemetrySample(), {
    time: SAMPLE_TIME,
    sessionId: SESSION_ID,
    carId: CAR_ID,
    seq: 42,
    rpm: 3_200,
    coolantC: 88.5,
    oilC: 96.25,
    speedKmh: 142,
    lat: 42.61,
    lon: 24.98,
    gLat: 0.8,
    gLon: -1.1,
    gVert: 0.05,
    lapNumber: 3,
    lapMs: 61_400,
    ...overrides,
  });

/**
 * Records the commands queued on a pipeline so the assertions can read them
 * back, and lets a test decide how `exec` resolves.
 */
const pipelineStub = () => {
  const commands: unknown[][] = [];
  let result: Promise<unknown> = Promise.resolve([[null, 1]]);

  const pipeline: Record<string, unknown> = {
    exec: () => result,
  };
  for (const name of ['publish', 'set', 'del']) {
    pipeline[name] = (...args: unknown[]) => {
      commands.push([name, ...args]);
      return pipeline;
    };
  }

  return {
    commands,
    pipeline,
    resolveWith: (value: Promise<unknown>) => {
      result = value;
    },
  };
};

describe('LivePublisherService', () => {
  let service: LivePublisherService;
  let stub: ReturnType<typeof pipelineStub>;
  let redis: { pipeline: jest.Mock };

  /** The JSON payload of the first `publish` command, decoded. */
  const published = (): LiveFrame =>
    JSON.parse(
      stub.commands.find(([name]) => name === 'publish')?.[2] as string,
    );

  beforeEach(async () => {
    stub = pipelineStub();
    redis = { pipeline: jest.fn(() => stub.pipeline) };

    const moduleRef = await Test.createTestingModule({
      providers: [
        LivePublisherService,
        { provide: REDIS_CLIENT, useValue: redis },
      ],
    }).compile();

    service = moduleRef.get(LivePublisherService);
  });

  describe('frames', () => {
    it('maps the stored sample onto the wire contract', async () => {
      service.publishFrame(sample());

      expect(published()).toEqual({
        v: 1,
        sessionId: SESSION_ID,
        carId: CAR_ID,
        // Server-anchored, as stored — never the device's own clock.
        t: SAMPLE_TIME.getTime(),
        // Stamped at publish, and the only field a latency figure may use.
        pt: expect.any(Number),
        seq: 42,
        rpm: 3_200,
        coolant: 88.5,
        oil: 96.25,
        speed: 142,
        lat: 42.61,
        lon: 24.98,
        gx: 0.8,
        gy: -1.1,
        gz: 0.05,
        lap: 3,
        lapMs: 61_400,
      });
    });

    it('refreshes the last-known value with a TTL, in the same round trip', async () => {
      // Without the TTL a car that stopped publishing an hour ago still reads
      // as live, and its last position sits in Redis indefinitely.
      service.publishFrame(sample());

      expect(stub.commands).toEqual([
        ['publish', `live:car:${CAR_ID}`, expect.any(String)],
        ['set', `lkv:car:${CAR_ID}`, expect.any(String), 'EX', LKV_TTL_SECONDS],
      ]);
      expect(redis.pipeline).toHaveBeenCalledTimes(1);
    });

    it('swallows a rejected exec rather than surfacing an unhandled rejection', async () => {
      stub.resolveWith(Promise.reject(new Error('redis is down')));

      expect(() => service.publishFrame(sample())).not.toThrow();
      // Let the rejected promise settle inside the service's own catch.
      await Promise.resolve();
    });

    it('swallows a client that throws synchronously', async () => {
      // A live-path failure must never propagate into handleFrame and skip the
      // durable enqueue that follows it.
      redis.pipeline.mockImplementation(() => {
        throw new Error('connection is closed');
      });

      expect(() => service.publishFrame(sample())).not.toThrow();
    });
  });

  describe('channel parity with the hypertable', () => {
    /**
     * The telemetry channel list is spelled out in three places: this entity,
     * the hypertable DDL in the baseline migration, and the live wire contract.
     * Nothing but this test connects the last one.
     *
     * Asserted by sentinel value rather than by name, because the mapping
     * deliberately renames (`coolantC` → `coolant`): a hand-written name table
     * here would just be a fourth copy to keep in step. Every column's value
     * has to come out somewhere in the payload, whatever it is called.
     */
    it('carries every column a sample has', () => {
      const properties = getMetadataArgsStorage()
        .columns.filter((column) => column.target === TelemetrySample)
        .map((column) => column.propertyName);

      const probe = new TelemetrySample();
      const sentinels = new Map<string, number>();

      properties.forEach((property, index) => {
        switch (property) {
          case 'time':
            probe.time = new Date(1_700_000_000_000 + index);
            break;
          case 'sessionId':
          case 'carId':
            probe[property] = `${property}-sentinel`;
            break;
          case 'ext':
            probe.ext = { sentinel: true };
            break;
          default:
            // Distinct per column, so a value appearing under the wrong key
            // still counts as unmapped.
            sentinels.set(property, 9_000 + index);
            probe[property] = 9_000 + index;
        }
      });

      service.publishFrame(probe);
      const payload = published();
      const values = new Set(Object.values(payload));

      for (const [property, sentinel] of sentinels) {
        expect({ property, carried: values.has(sentinel) }).toEqual({
          property,
          carried: true,
        });
      }

      expect(payload.t).toBe(probe.time.getTime());
      expect(payload.pt).toBeGreaterThan(0);
      expect(payload.sessionId).toBe('sessionId-sentinel');
      expect(payload.carId).toBe('carId-sentinel');
      expect(payload.ext).toEqual({ sentinel: true });
    });
  });

  describe('session events', () => {
    it('drops the last-known value when a run ends', async () => {
      // Left in place it would keep seeding new viewers for another five
      // minutes with a fix that looks current and is not.
      await service.publishEvent(CAR_ID, SESSION_ID, 'stop');

      expect(stub.commands).toEqual([
        ['publish', `live:car:${CAR_ID}:events`, expect.any(String)],
        ['del', `lkv:car:${CAR_ID}`],
      ]);
    });

    it('leaves the last-known value alone when a run starts', async () => {
      await service.publishEvent(CAR_ID, SESSION_ID, 'start');

      expect(stub.commands.map(([name]) => name)).toEqual(['publish']);
    });

    it('resolves even when the publish fails', async () => {
      stub.resolveWith(Promise.reject(new Error('redis is down')));

      await expect(
        service.publishEvent(CAR_ID, SESSION_ID, 'start'),
      ).resolves.toBeUndefined();
    });
  });
});
