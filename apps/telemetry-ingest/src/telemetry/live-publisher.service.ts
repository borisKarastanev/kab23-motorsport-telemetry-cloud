import {
  LIVE_FRAME_SCHEMA_VERSION,
  LKV_TTL_SECONDS,
  LiveFrame,
  LiveSessionEvent,
  LiveSessionEventName,
  REDIS_CLIENT,
  liveCarChannel,
  liveCarEventsChannel,
  lkvCarKey,
} from '@app/common';
import { Inject, Injectable, Logger } from '@nestjs/common';
import Redis, { ChainableCommander } from 'ioredis';
import { TelemetrySample } from './entities/telemetry-sample.entity';

/** One failure summary per window, whatever the frame rate. */
const FAILURE_LOG_INTERVAL_MS = 60_000;

/**
 * Publishes samples to the live bus on their way to the hypertable.
 *
 * **This is the fast half of a two-speed write.** `TelemetryWriterService`
 * batches rows for up to 250 ms before touching Postgres; publishing here first
 * means a viewer never waits on that flush, which is the whole reason the
 * <1–2 s budget has room in it for an LTE link.
 *
 * **Nothing here throws, and nothing here is awaited by the caller.** Redis is
 * a cache and a fan-out bus, never a system of record: every value it holds is
 * reconstructible from `telemetry_samples`. A Redis outage must therefore cost
 * the live view and nothing else — if a failure could propagate, it would take
 * down the durable path too, trading the one copy that matters for the one that
 * does not.
 */
@Injectable()
export class LivePublisherService {
  private readonly logger = new Logger(LivePublisherService.name);
  private failures = 0;
  private lastFailureLogMs = 0;

  constructor(@Inject(REDIS_CLIENT) private readonly redis: Redis) {}

  /**
   * Built from the persisted sample rather than from the raw frame, so the
   * value a viewer sees is by construction the value that was stored — one
   * mapping to keep correct instead of two that can drift apart.
   */
  publishFrame(sample: TelemetrySample): void {
    // The whole body is guarded, not just the promise: a client in a bad state
    // can throw synchronously from `pipeline()`, and that would propagate into
    // `TelemetryService.handleFrame` and skip the enqueue below it. The rule
    // that the live path cannot break the durable path is enforced here, once,
    // rather than trusted at every call site.
    try {
      const payload = JSON.stringify(LivePublisherService.toLiveFrame(sample));

      // Publish and refresh the last-known value together: two round trips per
      // frame per car would be latency spent on nothing.
      void this.run(
        this.redis
          .pipeline()
          .publish(liveCarChannel(sample.carId), payload)
          .set(lkvCarKey(sample.carId), payload, 'EX', LKV_TTL_SECONDS),
      );
    } catch {
      this.countFailure();
    }
  }

  /**
   * A run opening or closing. Awaited by the caller, unlike frames: these are
   * once-per-session and ordering matters — a viewer told a session ended
   * before its last frames arrived would show a truncated run.
   */
  async publishEvent(
    carId: string,
    sessionId: string,
    event: LiveSessionEventName,
  ): Promise<void> {
    const payload: LiveSessionEvent = {
      v: LIVE_FRAME_SCHEMA_VERSION,
      carId,
      sessionId,
      event,
      t: Date.now(),
    };

    try {
      const pipeline = this.redis
        .pipeline()
        .publish(liveCarEventsChannel(carId), JSON.stringify(payload));

      // The run is over, so its last position is history, not a live reading.
      // Left in place it would keep seeding new viewers for another five
      // minutes with a fix that looks current and is not.
      if (event === 'stop') {
        pipeline.del(lkvCarKey(carId));
      }

      await this.run(pipeline);
    } catch {
      this.countFailure();
    }
  }

  /**
   * Runs a pipeline and counts anything that went wrong on it.
   *
   * Shared by both publishers because the failure mode is not obvious and is
   * easy to leave out of the second one: `exec` rejects only on a
   * connection-level failure, so a command that failed on its own — a `DEL` of
   * the last-known value that never landed — reports in the *results* and would
   * otherwise pass for success.
   */
  private async run(pipeline: ChainableCommander): Promise<void> {
    try {
      const results = await pipeline.exec();
      if (results?.some(([error]) => error)) {
        this.countFailure();
      }
    } catch {
      this.countFailure();
    }
  }

  private static toLiveFrame(sample: TelemetrySample): LiveFrame {
    return {
      v: LIVE_FRAME_SCHEMA_VERSION,
      sessionId: sample.sessionId,
      carId: sample.carId,
      // Already server-anchored by DeviceRegistryService — the device's own
      // clock reaches neither the hypertable nor a browser.
      t: sample.time.getTime(),
      // Stamped here, not at the sample's time: see the field comment. `t`
      // carries the session's anchoring offset and cannot measure delivery.
      pt: Date.now(),
      seq: sample.seq,
      rpm: sample.rpm,
      coolant: sample.coolantC,
      oil: sample.oilC,
      speed: sample.speedKmh,
      lat: sample.lat,
      lon: sample.lon,
      gx: sample.gLat,
      gy: sample.gLon,
      gz: sample.gVert,
      lap: sample.lapNumber,
      lapMs: sample.lapMs,
      ext: sample.ext,
    };
  }

  /**
   * Counted and summarised on a timer, never logged per frame: at 10 Hz per car
   * a per-failure log line would turn a Redis blip into a second outage in the
   * log sink.
   */
  private countFailure(): void {
    this.failures += 1;

    const now = Date.now();
    if (now - this.lastFailureLogMs < FAILURE_LOG_INTERVAL_MS) {
      return;
    }
    this.lastFailureLogMs = now;

    const count = this.failures;
    this.failures = 0;
    this.logger.warn(`Live publish failed for ${count} message(s)`);
  }
}
