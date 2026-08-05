import { Inject, Logger, Module, OnApplicationShutdown } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Redis, { RedisOptions } from 'ioredis';
import { ConfigModule } from '../config/config.module';
import { REDIS_CLIENT, REDIS_SUBSCRIBER } from './redis.constants';

const logger = new Logger('Redis');

const baseOptions = (configService: ConfigService): RedisOptions => ({
  host: configService.get<string>('REDIS_HOST'),
  port: configService.get<number>('REDIS_PORT'),
  // Empty string is how the schema spells "no password", which is the local
  // compose setup; ioredis wants the option absent rather than blank.
  password: configService.get<string>('REDIS_PASSWORD') || undefined,
});

/**
 * ioredis emits `error` on every failed reconnect attempt, and an `error` event
 * with no listener is an uncaught exception that takes the process down. A
 * Redis outage must degrade the live view, not kill ingest — the hypertable is
 * the system of record and its write path does not depend on Redis at all.
 */
const attachErrorLogging = (client: Redis, role: string): Redis => {
  client.on('error', (error: Error & { code?: string }) => {
    // Message only. Never the payload: these connections carry GPS traces.
    // Falls back to the code and name because ioredis raises socket errors —
    // ECONNREFUSED being the common one — with an empty `message`, which would
    // otherwise log as "connection error:" and say nothing.
    const reason = error.message || error.code || error.name || 'unknown';
    logger.warn(`${role} connection error: ${reason}`);
  });
  return client;
};

/**
 * One connection, described by what makes it different from the other.
 *
 * Both connections are otherwise identical, and the pair only stays that way if
 * there is one place that builds them: TLS in Phase 5, a `connectTimeout`, a
 * retry strategy — each is one edit here rather than two that can drift.
 */
const connection = (token: string, role: string, extra: RedisOptions) => ({
  provide: token,
  inject: [ConfigService],
  useFactory: (configService: ConfigService) =>
    attachErrorLogging(
      new Redis({ ...baseOptions(configService), ...extra }),
      role,
    ),
});

/**
 * Redis for the live path: pub/sub fan-out and the last-known-value cache.
 *
 * Not durable storage and never a fallback for one. Everything here is
 * reconstructible from the hypertable; nothing is only here.
 */
@Module({
  imports: [ConfigModule],
  providers: [
    connection(REDIS_CLIENT, 'client', {
      // Without this, ioredis buffers commands in memory while disconnected. At
      // 10 Hz per car a Redis outage would grow an unbounded queue of driver GPS
      // positions in the ingest heap and then flush hours-stale frames to
      // viewers on reconnect. Live data that missed its moment is worthless;
      // failing the command is the correct loss.
      enableOfflineQueue: false,
    }),
    connection(REDIS_SUBSCRIBER, 'subscriber', {
      // Connects on the first `subscribe`, so a process that only publishes —
      // telemetry-ingest — never opens this socket at all.
      lazyConnect: true,
    }),
  ],
  exports: [REDIS_CLIENT, REDIS_SUBSCRIBER],
})
export class RedisModule implements OnApplicationShutdown {
  constructor(
    @Inject(REDIS_CLIENT) private readonly client: Redis,
    @Inject(REDIS_SUBSCRIBER) private readonly subscriber: Redis,
  ) {}

  /**
   * `quit` on a client that never connected (the lazy subscriber in ingest)
   * rejects, and a half-open connection can reject too — neither is a reason to
   * fail a shutdown that is already under way.
   */
  async onApplicationShutdown(): Promise<void> {
    await Promise.allSettled([this.client.quit(), this.subscriber.quit()]);
  }
}
