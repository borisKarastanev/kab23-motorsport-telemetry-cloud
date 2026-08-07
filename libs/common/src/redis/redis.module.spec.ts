import { Test } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { RedisModule } from './redis.module';
import { REDIS_CLIENT, REDIS_SUBSCRIBER } from './redis.constants';

/**
 * `RedisModule` opens a real connection the moment its client provider is
 * constructed, which is the right behaviour in production but wrong for a
 * wiring test — nothing here should touch a socket. `ioredis` itself is
 * mocked instead, and every assertion below reads the constructor arguments
 * and `on('error', ...)` registration the module handed it.
 */
class FakeRedis {
  static instances: FakeRedis[] = [];
  public options: Record<string, unknown>;
  public handlers: Record<string, ((...args: unknown[]) => void)[]> = {};
  public quit = jest.fn().mockResolvedValue('OK');

  constructor(options: Record<string, unknown>) {
    this.options = options;
    FakeRedis.instances.push(this);
  }

  on(event: string, handler: (...args: unknown[]) => void) {
    (this.handlers[event] ??= []).push(handler);
    return this;
  }

  emit(event: string, ...args: unknown[]) {
    for (const handler of this.handlers[event] ?? []) {
      handler(...args);
    }
  }
}

jest.mock('ioredis', () => ({
  __esModule: true,
  default: jest.fn().mockImplementation((options) => new FakeRedis(options)),
}));

describe('RedisModule', () => {
  const configService = {
    get: (key: string) =>
      ({
        REDIS_HOST: 'localhost',
        REDIS_PORT: 6379,
        REDIS_PASSWORD: '',
      })[key],
  } as unknown as ConfigService;

  beforeEach(() => {
    FakeRedis.instances = [];
  });

  const compiled = async () =>
    Test.createTestingModule({
      imports: [RedisModule],
    })
      .overrideProvider(ConfigService)
      .useValue(configService)
      .compile();

  it('wires REDIS_CLIENT and REDIS_SUBSCRIBER as two distinct connections', async () => {
    const moduleRef = await compiled();

    const client = moduleRef.get(REDIS_CLIENT);
    const subscriber = moduleRef.get(REDIS_SUBSCRIBER);

    expect(client).not.toBe(subscriber);
    expect(FakeRedis.instances).toHaveLength(2);
  });

  it('drops an empty REDIS_PASSWORD rather than handing ioredis a blank string', async () => {
    // The schema spells "no password" as an empty string, but ioredis wants
    // the option entirely absent rather than blank.
    await compiled();

    for (const instance of FakeRedis.instances) {
      expect(instance.options.password).toBeUndefined();
    }
  });

  it('never buffers commands on the client while disconnected', async () => {
    // At 10 Hz per car, buffering during a Redis outage would grow an
    // unbounded queue of driver GPS positions and then flush hours-stale
    // frames to viewers on reconnect.
    await compiled();

    const client = FakeRedis.instances[0];
    expect(client.options.enableOfflineQueue).toBe(false);
  });

  it('connects the subscriber lazily so a publish-only process never opens it', async () => {
    await compiled();

    const subscriber = FakeRedis.instances[1];
    expect(subscriber.options.lazyConnect).toBe(true);
  });

  it('attaches an error listener to both connections so a reconnect failure never crashes the process', async () => {
    // ioredis treats an `error` event with no listener as an uncaught
    // exception; not throwing here is the regression this guards.
    await compiled();

    for (const instance of FakeRedis.instances) {
      expect(() =>
        instance.emit(
          'error',
          Object.assign(new Error(''), { code: 'ECONNREFUSED' }),
        ),
      ).not.toThrow();
    }
  });

  it('quits both connections on application shutdown, tolerating a rejection', async () => {
    const moduleRef = await compiled();
    const redisModule = moduleRef.get(RedisModule);

    // The lazy subscriber may never have connected, so `quit()` on it can
    // reject — that must not fail a shutdown that is already under way.
    FakeRedis.instances[1].quit.mockRejectedValue(new Error('not connected'));

    await expect(
      redisModule.onApplicationShutdown(),
    ).resolves.toBeUndefined();
    expect(FakeRedis.instances[0].quit).toHaveBeenCalled();
    expect(FakeRedis.instances[1].quit).toHaveBeenCalled();
  });
});
