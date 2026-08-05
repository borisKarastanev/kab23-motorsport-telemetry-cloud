import { REDIS_SUBSCRIBER } from '@app/common';
import { Test } from '@nestjs/testing';
import {
  LiveTelemetryBusMessage,
  LiveTelemetryBusService,
} from './live-telemetry-bus.service';

const CAR_ID = '33333333-3333-4333-8333-333333333333';
const OTHER_CAR_ID = '44444444-4444-4444-8444-444444444444';

const frame = (overrides: Record<string, unknown> = {}) =>
  JSON.stringify({ v: 1, carId: CAR_ID, seq: 1, ...overrides });

describe('LiveTelemetryBusService', () => {
  let service: LiveTelemetryBusService;
  let redis: {
    on: jest.Mock;
    subscribe: jest.Mock;
    unsubscribe: jest.Mock;
  };
  let received: LiveTelemetryBusMessage[];

  /** Feeds a message in as ioredis would, through the registered listener. */
  const deliver = (channel: string, payload: string) => {
    const listener = redis.on.mock.calls.find(
      ([event]) => event === 'message',
    )?.[1];
    listener(channel, payload);
  };

  beforeEach(async () => {
    redis = {
      on: jest.fn(),
      subscribe: jest.fn().mockResolvedValue(1),
      unsubscribe: jest.fn().mockResolvedValue(0),
    };
    received = [];

    const moduleRef = await Test.createTestingModule({
      providers: [
        LiveTelemetryBusService,
        { provide: REDIS_SUBSCRIBER, useValue: redis },
      ],
    }).compile();

    service = moduleRef.get(LiveTelemetryBusService);
    service.onModuleInit();
    service.setHandler((message) => received.push(message));
  });

  describe('refcounting', () => {
    it('subscribes once however many viewers a car has', async () => {
      // A pattern subscribe would avoid the bookkeeping and put every team's
      // GPS through this instance; the bookkeeping is the cheaper trade.
      await service.addViewer(CAR_ID);
      await service.addViewer(CAR_ID);

      expect(redis.subscribe).toHaveBeenCalledTimes(1);
    });

    it('unsubscribes only when the last viewer leaves', async () => {
      await service.addViewer(CAR_ID);
      await service.addViewer(CAR_ID);

      await service.removeViewer(CAR_ID);
      expect(redis.unsubscribe).not.toHaveBeenCalled();

      await service.removeViewer(CAR_ID);
      expect(redis.unsubscribe).toHaveBeenCalledTimes(1);
    });

    it('keeps cars independent', async () => {
      await service.addViewer(CAR_ID);
      await service.addViewer(OTHER_CAR_ID);
      await service.removeViewer(CAR_ID);

      expect(redis.subscribe).toHaveBeenCalledTimes(2);
      expect(redis.unsubscribe).toHaveBeenCalledTimes(1);
    });

    it('rolls the count back when subscribing fails', async () => {
      // Otherwise the car looks subscribed forever and its viewers sit on a
      // silent socket until they reconnect.
      redis.subscribe.mockRejectedValueOnce(new Error('redis is down'));

      await expect(service.addViewer(CAR_ID)).rejects.toThrow('redis is down');

      redis.subscribe.mockResolvedValue(1);
      await service.addViewer(CAR_ID);
      expect(redis.subscribe).toHaveBeenCalledTimes(2);
    });

    it('fails a viewer that arrived while a failing subscribe was in flight', async () => {
      // The second viewer must not inherit a subscription that never
      // succeeded. Counting alone would pin the car at refcount 1 with nothing
      // behind it, and every later viewer would short-circuit on that count
      // and never re-subscribe.
      let reject: (error: Error) => void;
      redis.subscribe.mockReturnValueOnce(
        new Promise((_, no) => {
          reject = no;
        }),
      );

      const first = service.addViewer(CAR_ID);
      const second = service.addViewer(CAR_ID);
      reject(new Error('redis is down'));

      await expect(first).rejects.toThrow('redis is down');
      await expect(second).rejects.toThrow('redis is down');

      // And the car is genuinely released, so the next viewer tries again.
      redis.subscribe.mockResolvedValue(1);
      await service.addViewer(CAR_ID);
      expect(redis.subscribe).toHaveBeenCalledTimes(2);
    });

    it('lets a viewer share a subscribe that is still in flight', async () => {
      let resolve: (value: unknown) => void;
      redis.subscribe.mockReturnValueOnce(
        new Promise((yes) => {
          resolve = yes;
        }),
      );

      const first = service.addViewer(CAR_ID);
      const second = service.addViewer(CAR_ID);
      resolve(1);

      await expect(Promise.all([first, second])).resolves.toBeDefined();
      expect(redis.subscribe).toHaveBeenCalledTimes(1);
    });

    it('ignores a removal for a car with no viewers', async () => {
      await service.removeViewer(CAR_ID);

      expect(redis.unsubscribe).not.toHaveBeenCalled();
    });

    it('survives a failed unsubscribe', async () => {
      // The worst case is an idle subscription the next viewer reuses — not
      // worth failing a disconnect over.
      redis.unsubscribe.mockRejectedValueOnce(new Error('redis is down'));
      await service.addViewer(CAR_ID);

      await expect(service.removeViewer(CAR_ID)).resolves.toBeUndefined();
    });
  });

  describe('dispatch', () => {
    it('routes frames and events to their kind', () => {
      deliver(`live:car:${CAR_ID}`, frame());
      deliver(
        `live:car:${CAR_ID}:events`,
        JSON.stringify({ v: 1, carId: CAR_ID, event: 'stop' }),
      );

      expect(received.map((message) => message.kind)).toEqual([
        'frame',
        'event',
      ]);
    });

    it('takes the car from the channel, not the payload', () => {
      // The room a message is fanned out to must not be something a publisher
      // can choose by putting a different id in the body.
      deliver(`live:car:${CAR_ID}`, frame({ carId: OTHER_CAR_ID }));

      expect(received[0].carId).toBe(CAR_ID);
    });

    it('drops a payload from an unknown schema version', () => {
      deliver(`live:car:${CAR_ID}`, frame({ v: 2 }));

      expect(received).toHaveLength(0);
    });

    it('drops an unparseable payload without throwing', () => {
      expect(() => deliver(`live:car:${CAR_ID}`, 'not json')).not.toThrow();
      expect(received).toHaveLength(0);
    });

    it('ignores a channel that is not one of ours', () => {
      deliver('some:other:channel', frame());

      expect(received).toHaveLength(0);
    });
  });
});
