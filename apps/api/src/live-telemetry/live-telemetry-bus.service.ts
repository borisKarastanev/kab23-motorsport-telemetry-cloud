import {
  LiveChannelKind,
  LiveFrame,
  LiveSessionEvent,
  REDIS_SUBSCRIBER,
  liveCarChannel,
  liveCarEventsChannel,
  parseLiveChannel,
  parseLiveMessage,
} from '@app/common';
import { Inject, Injectable, Logger, OnModuleInit } from '@nestjs/common';
import Redis from 'ioredis';

export interface LiveTelemetryBusMessage {
  carId: string;
  kind: LiveChannelKind;
  payload: LiveFrame | LiveSessionEvent;
}

export type LiveTelemetryBusHandler = (
  message: LiveTelemetryBusMessage,
) => void;

/**
 * The API's half of the live bus: subscribes to the cars somebody is actually
 * watching and hands their messages on.
 *
 * **Subscriptions are refcounted per car, not a pattern subscribe.**
 * `PSUBSCRIBE live:car:*` is one line and would be wrong: every API instance
 * would then decode every car's frames on the platform — burning CPU on cars
 * nobody is watching, and routing other teams' GPS through a code path that has
 * no reason to touch it. A car is subscribed when its first viewer arrives and
 * unsubscribed when its last one leaves.
 *
 * A useful consequence of the bus being the source of truth: because fan-out
 * comes from Redis rather than from inter-node socket.io emits, running more
 * than one `api` instance needs no `@socket.io/redis-adapter`. Each instance
 * subscribes independently and serves its own clients.
 *
 * Knows nothing about WebSockets. It reports messages to a handler the gateway
 * installs, so the transport stays in one place and this stays testable without
 * one.
 */
@Injectable()
export class LiveTelemetryBusService implements OnModuleInit {
  private readonly logger = new Logger(LiveTelemetryBusService.name);

  /**
   * carId → viewer count and the subscribe that established it.
   *
   * The promise is held, not just a count, for the same reason
   * `DeviceRegistryService` holds one: a second viewer arriving while the first
   * viewer's `SUBSCRIBE` is still in flight must wait on that result rather
   * than assume it succeeded. Counting alone leaves a car pinned at a non-zero
   * refcount with no subscription behind it if the first one fails, and every
   * later viewer then short-circuits on the count and never re-subscribes.
   */
  private readonly cars = new Map<
    string,
    { count: number; subscribing: Promise<void> }
  >();

  private handler: LiveTelemetryBusHandler | null = null;

  constructor(@Inject(REDIS_SUBSCRIBER) private readonly redis: Redis) {}

  onModuleInit(): void {
    this.redis.on('message', (channel: string, payload: string) =>
      this.dispatch(channel, payload),
    );
  }

  /**
   * The gateway installs itself here. One handler, deliberately: there is a
   * single consumer, and an emitter with silent multi-registration would make
   * "who is delivering these" a question rather than a fact.
   */
  setHandler(handler: LiveTelemetryBusHandler): void {
    this.handler = handler;
  }

  /**
   * Called once per viewer joining a car. Authorization is the gateway's job
   * and must already have happened — this method takes a car id on trust.
   */
  async addViewer(carId: string): Promise<void> {
    let entry = this.cars.get(carId);

    if (!entry) {
      entry = {
        count: 0,
        subscribing: this.redis
          .subscribe(liveCarChannel(carId), liveCarEventsChannel(carId))
          .then(() => undefined),
      };
      this.cars.set(carId, entry);
    }

    entry.count += 1;

    try {
      // Awaited even when someone else issued it: if that subscribe failed,
      // this viewer is not subscribed either and must hear about it.
      await entry.subscribing;
    } catch (error) {
      // Dropped outright rather than decremented, and for every waiter rather
      // than just this one: the entry must not survive as a count with no
      // subscription behind it, or the next viewer would trust it and sit on a
      // silent socket forever. Guarded against a newer entry — a viewer that
      // arrived after the failure and started a fresh subscribe.
      if (this.cars.get(carId) === entry) {
        this.cars.delete(carId);
      }
      throw error;
    }
  }

  /** Called once per viewer leaving a car, including on disconnect. */
  async removeViewer(carId: string): Promise<void> {
    if (!this.release(carId)) {
      return;
    }

    try {
      await this.redis.unsubscribe(
        liveCarChannel(carId),
        liveCarEventsChannel(carId),
      );
    } catch (error) {
      // Not worth failing a disconnect over: the worst case is an idle
      // subscription this instance ignores, which the next viewer reuses.
      this.logger.warn(
        `Could not unsubscribe a car channel: ${(error as Error).message}`,
      );
    }
  }

  /** Decrements the refcount; true when that was the last viewer. */
  private release(carId: string): boolean {
    const entry = this.cars.get(carId);

    if (!entry) {
      return false;
    }

    if (entry.count <= 1) {
      this.cars.delete(carId);
      return true;
    }

    entry.count -= 1;
    return false;
  }

  private dispatch(channel: string, raw: string): void {
    const parsed = parseLiveChannel(channel);
    if (!parsed || !this.handler) {
      return;
    }

    // Same discipline as the MQTT contract: a publisher from a build that means
    // something different by these fields is dropped, not guessed at. Never log
    // the body — it is a driver's position.
    const payload = parseLiveMessage<LiveFrame | LiveSessionEvent>(raw);
    if (!payload) {
      this.logger.warn('Discarded an unparseable or unknown-version message');
      return;
    }

    // The channel is authoritative for the car, not the payload: the room a
    // message is fanned out to must not be something a publisher can choose.
    this.handler({ carId: parsed.carId, kind: parsed.kind, payload });
  }
}
