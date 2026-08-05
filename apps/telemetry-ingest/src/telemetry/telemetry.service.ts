import { Injectable, Logger } from '@nestjs/common';
import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';
import { IngestSessionsService } from '../sessions/ingest-sessions.service';
import {
  DeviceRegistryService,
  SessionContext,
} from './device-registry.service';
import { TelemetryWriterService } from './telemetry-writer.service';
import { LivePublisherService } from './live-publisher.service';
import { TelemetrySample } from './entities/telemetry-sample.entity';
import {
  TELEMETRY_SCHEMA_VERSION,
  TelemetryFrameDto,
} from './dto/telemetry-frame.dto';
import { BackfillBatchDto } from './dto/backfill-batch.dto';
import { SessionEventDto } from './dto/session-event.dto';

/** Never log more than one drop summary per window, whatever the frame rate. */
const DROP_LOG_INTERVAL_MS = 60_000;

type DropReason =
  'unknown device' | 'malformed frame' | 'unsupported schema version';

/**
 * Turns MQTT messages into hypertable rows.
 *
 * Nothing here throws. These are MQTT *events*, not requests: there is no
 * caller to receive an error, and an exception escaping an event handler would
 * just be logged by Nest with the payload attached — which for this payload
 * means a driver's GPS position in a log sink. Bad input is counted and
 * dropped, and the counts are summarised on a timer rather than per frame.
 */
@Injectable()
export class TelemetryService {
  private readonly logger = new Logger(TelemetryService.name);
  private readonly drops = new Map<DropReason, number>();
  private lastDropLogMs = 0;

  constructor(
    private readonly registry: DeviceRegistryService,
    private readonly sessions: IngestSessionsService,
    private readonly writer: TelemetryWriterService,
    private readonly live: LivePublisherService,
  ) {}

  async handleFrame(deviceId: string, payload: unknown): Promise<void> {
    const frame = this.parse(TelemetryFrameDto, payload);
    if (!frame) {
      return;
    }

    const context = await this.resolve(deviceId, frame.sid, frame.mono);
    if (!context) {
      return;
    }

    // Live first, durable second — and the same object for both, so a viewer
    // cannot be shown a value that differs from the one stored. The publish is
    // fire-and-forget: it must not delay, and cannot fail, the write that
    // matters. See LivePublisherService.
    const sample = TelemetryService.toSample(context, frame);
    this.live.publishFrame(sample);
    this.writer.enqueue(sample);
  }

  /**
   * A replayed batch from the device's store-and-forward spool. Identical to
   * the live path per frame — the only difference is that these arrive late,
   * possibly more than once, and the dedup index absorbs the repeats.
   *
   * **Deliberately not published to the live bus.** A drained backlog is
   * history: pushing an hour of it at a viewer would rewind their map and
   * gauges mid-session and leave the car apparently somewhere it no longer is.
   * It goes to the hypertable, where the analysis path will find it.
   */
  async handleBackfill(deviceId: string, payload: unknown): Promise<void> {
    const batch = this.parse(BackfillBatchDto, payload);
    if (!batch?.frames.length) {
      // An empty batch must not reach `resolve`: it would open the run anchored
      // at mono 0, and every later frame would then be stamped a whole device
      // uptime into the future — outside any window a reader asks for.
      return;
    }

    // Anchored on the batch's own first frame so a backlog that outlived its
    // cached context still rebuilds the same timeline from the session row.
    const context = await this.resolve(
      deviceId,
      batch.sid,
      batch.frames[0].mono,
    );
    if (!context) {
      return;
    }

    this.writer.enqueueAll(
      batch.frames
        .filter((frame) => frame.sid === batch.sid)
        .map((frame) => TelemetryService.toSample(context, frame)),
    );
  }

  async handleSessionEvent(deviceId: string, payload: unknown): Promise<void> {
    const event = this.parse(SessionEventDto, payload);
    if (!event) {
      return;
    }

    if (event.event === 'start') {
      const context = await this.resolve(
        deviceId,
        event.sid,
        event.mono,
        event.track,
      );
      // The session id is ours and safe to log; the deviceId is not — it
      // identifies a specific car, which is exactly the linkage the rest of the
      // codebase keeps out of log sinks (see AbstractRepository).
      if (context) {
        this.logger.log(`Session ${context.sessionId} opened by its device`);
        await this.live.publishEvent(context.carId, context.sessionId, 'start');
      }
      return;
    }

    // Resolve the publishing car first: closing on `sid` alone would let any
    // car end another team's run in progress just by echoing their sid. Looked
    // up rather than routed through `resolve` so a stop for a run we never saw
    // does not create a session purely in order to close it.
    const car = await this.sessions.findCarByDeviceId(deviceId);
    if (!car) {
      this.countDrop('unknown device');
      return;
    }

    const session = await this.sessions.closeSession(car.id, event.sid);
    // Flush before forgetting the run, so buffered samples are written while
    // their context is still the one they were built against.
    await this.writer.flush();

    // Announced only after the flush: a viewer told the run ended while its
    // last 250 ms of samples were still buffered would stop reading, then find
    // the stored session longer than the one they watched.
    if (session) {
      await this.live.publishEvent(car.id, session.id, 'stop');
    }

    this.registry.forget(deviceId, event.sid);
  }

  // ---------------------------------------------------------------------------

  private async resolve(
    deviceId: string,
    sid: string,
    monoMs: number,
    track?: string,
  ): Promise<SessionContext | null> {
    try {
      const context = await this.registry.resolve(deviceId, sid, monoMs, track);
      if (!context) {
        this.countDrop('unknown device');
      }
      return context;
    } catch (error) {
      this.logger.error(
        `Could not resolve a session: ${(error as Error).message}`,
      );
      return null;
    }
  }

  private static toSample(
    context: SessionContext,
    frame: TelemetryFrameDto,
  ): TelemetrySample {
    const sample = new TelemetrySample();
    sample.time = DeviceRegistryService.sampleTime(context, frame.mono);
    sample.sessionId = context.sessionId;
    sample.carId = context.carId;
    sample.seq = frame.seq;
    sample.rpm = frame.rpm;
    sample.coolantC = frame.coolant;
    sample.oilC = frame.oil;
    sample.speedKmh = frame.speed;
    sample.lat = frame.lat;
    sample.lon = frame.lon;
    sample.gLat = frame.gx;
    sample.gLon = frame.gy;
    sample.gVert = frame.gz;
    sample.lapNumber = frame.lap;
    sample.lapMs = frame.lapMs;
    sample.ext = frame.ext;
    return sample;
  }

  /**
   * Validates and shapes a payload, or counts a drop and returns null.
   *
   * The schema version is checked before anything else: a device sending a
   * version this build does not know is a device whose fields may mean
   * something different, and guessing at them would write plausible-looking
   * wrong data.
   */
  private parse<T extends { v: number }>(
    cls: new () => T,
    payload: unknown,
  ): T | null {
    if (typeof payload !== 'object' || payload === null) {
      this.countDrop('malformed frame');
      return null;
    }

    // Read off the raw payload, before the transform: an unknown version is
    // discarded whatever else it contains, so building an instance of a shape
    // it may not be would be work spent on a frame already destined to drop.
    if ((payload as { v?: unknown }).v !== TELEMETRY_SCHEMA_VERSION) {
      this.countDrop('unsupported schema version');
      return null;
    }

    const instance = plainToInstance(cls, payload, {
      enableImplicitConversion: false,
    });

    if (validateSync(instance as object, { whitelist: true }).length) {
      this.countDrop('malformed frame');
      return null;
    }

    return instance;
  }

  private countDrop(reason: DropReason): void {
    this.drops.set(reason, (this.drops.get(reason) ?? 0) + 1);

    const now = Date.now();
    if (now - this.lastDropLogMs < DROP_LOG_INTERVAL_MS) {
      return;
    }
    this.lastDropLogMs = now;

    const summary = [...this.drops]
      .map(([name, count]) => `${name}: ${count}`)
      .join(', ');
    this.drops.clear();
    this.logger.warn(`Dropped telemetry (${summary})`);
  }
}
