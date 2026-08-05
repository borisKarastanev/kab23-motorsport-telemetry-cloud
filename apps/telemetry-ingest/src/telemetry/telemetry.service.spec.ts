import { Test } from '@nestjs/testing';
import { IngestSessionsService } from '../sessions/ingest-sessions.service';
import {
  DeviceRegistryService,
  SessionContext,
} from './device-registry.service';
import { TelemetryService } from './telemetry.service';
import { TelemetryWriterService } from './telemetry-writer.service';
import { LivePublisherService } from './live-publisher.service';
import { TelemetrySample } from './entities/telemetry-sample.entity';

const DEVICE_ID = 'TEST123';
const SID = '11111111-1111-4111-8111-111111111111';
const SESSION_ID = '22222222-2222-4222-8222-222222222222';
const CAR_ID = '33333333-3333-4333-8333-333333333333';

const ANCHOR_MS = Date.parse('2026-08-01T10:00:00.000Z');

const context = (overrides: Partial<SessionContext> = {}): SessionContext => ({
  sessionId: SESSION_ID,
  carId: CAR_ID,
  anchorMs: ANCHOR_MS,
  monoStartMs: 1_000,
  ...overrides,
});

const frame = (overrides: Record<string, unknown> = {}) => ({
  v: 1,
  sid: SID,
  seq: 1,
  ts: Date.now(),
  mono: 1_000,
  rpm: 3_200,
  coolant: 88.5,
  speed: 142,
  lat: 42.61,
  lon: 24.98,
  ...overrides,
});

describe('TelemetryService', () => {
  let service: TelemetryService;
  let registry: jest.Mocked<Partial<DeviceRegistryService>>;
  let sessions: jest.Mocked<Partial<IngestSessionsService>>;
  let writer: jest.Mocked<Partial<TelemetryWriterService>>;
  let live: jest.Mocked<Partial<LivePublisherService>>;

  const written = (): TelemetrySample[] =>
    writer.enqueue.mock.calls.map(([sample]) => sample);

  beforeEach(async () => {
    registry = {
      resolve: jest.fn().mockResolvedValue(context()),
      forget: jest.fn(),
    };
    sessions = {
      closeSession: jest.fn().mockResolvedValue({ id: SESSION_ID } as never),
      findCarByDeviceId: jest.fn().mockResolvedValue({ id: CAR_ID } as never),
    };
    writer = {
      enqueue: jest.fn(),
      enqueueAll: jest.fn(),
      flush: jest.fn().mockResolvedValue(undefined),
    };
    live = {
      publishFrame: jest.fn(),
      publishEvent: jest.fn().mockResolvedValue(undefined),
    };

    const moduleRef = await Test.createTestingModule({
      providers: [
        TelemetryService,
        { provide: DeviceRegistryService, useValue: registry },
        { provide: IngestSessionsService, useValue: sessions },
        { provide: TelemetryWriterService, useValue: writer },
        { provide: LivePublisherService, useValue: live },
      ],
    }).compile();

    service = moduleRef.get(TelemetryService);
  });

  describe('sample timing', () => {
    it('ignores the device wall clock in favour of the monotonic counter', async () => {
      // A Pi 4 has no RTC: until NTP syncs over LTE its clock can read 1970.
      // The sample must still land 4 s after the session anchor.
      await service.handleFrame(
        DEVICE_ID,
        frame({ ts: 0, mono: 5_000, seq: 42 }),
      );

      expect(written()[0].time).toEqual(new Date(ANCHOR_MS + 4_000));
    });

    it('keeps a run contiguous when the device clock steps mid-session', async () => {
      await service.handleFrame(DEVICE_ID, frame({ ts: 0, mono: 2_000 }));
      await service.handleFrame(
        DEVICE_ID,
        // NTP landed between these two frames and jumped the clock years.
        frame({ ts: Date.parse('2031-01-01T00:00:00Z'), mono: 3_000, seq: 2 }),
      );

      const [first, second] = written();
      expect(second.time.getTime() - first.time.getTime()).toBe(1_000);
    });
  });

  describe('live path', () => {
    it('publishes a frame before it is queued for the database', async () => {
      // The whole latency argument rests on this order: the writer buffers for
      // up to 250 ms, so a viewer that waited on it would spend a quarter of
      // the glass-to-glass budget on a batch it does not need.
      await service.handleFrame(DEVICE_ID, frame());

      expect(live.publishFrame.mock.invocationCallOrder[0]).toBeLessThan(
        writer.enqueue.mock.invocationCallOrder[0],
      );
    });

    it('publishes the same object it stores', async () => {
      // Two independent mappings would let the live view and the stored row
      // disagree about what the car was doing.
      await service.handleFrame(DEVICE_ID, frame());

      expect(live.publishFrame.mock.calls[0][0]).toBe(written()[0]);
    });

    it('never publishes a replayed backfill batch', async () => {
      // A drained backlog is history. Pushing it at a viewer would rewind the
      // map and show the car somewhere it no longer is.
      await service.handleBackfill(DEVICE_ID, {
        v: 1,
        sid: SID,
        frames: [frame({ seq: 1 }), frame({ seq: 2, mono: 1_100 })],
      });

      expect(writer.enqueueAll).toHaveBeenCalled();
      expect(live.publishFrame).not.toHaveBeenCalled();
    });

    it('announces a stop only after the buffered samples are flushed', async () => {
      // Otherwise a viewer stops reading, then finds the stored session longer
      // than the one they watched.
      await service.handleSessionEvent(DEVICE_ID, {
        v: 1,
        sid: SID,
        event: 'stop',
        mono: 900_000,
      });

      expect(live.publishEvent).toHaveBeenCalledWith(
        CAR_ID,
        SESSION_ID,
        'stop',
      );
      expect(writer.flush.mock.invocationCallOrder[0]).toBeLessThan(
        live.publishEvent.mock.invocationCallOrder[0],
      );
    });

    it('announces nothing when a stop closed no session', async () => {
      // A retransmitted stop must not end the run a second time.
      sessions.closeSession.mockResolvedValue(null);

      await service.handleSessionEvent(DEVICE_ID, {
        v: 1,
        sid: SID,
        event: 'stop',
        mono: 900_000,
      });

      expect(live.publishEvent).not.toHaveBeenCalled();
    });
  });

  describe('dropping bad input', () => {
    it('drops a frame from an unknown device without throwing', async () => {
      registry.resolve.mockResolvedValue(null);

      await expect(
        service.handleFrame(DEVICE_ID, frame()),
      ).resolves.toBeUndefined();
      expect(writer.enqueue).not.toHaveBeenCalled();
    });

    it('drops a frame whose schema version it does not know', async () => {
      // Fields may mean something different in v2; writing them anyway would
      // produce plausible-looking wrong data.
      await service.handleFrame(DEVICE_ID, frame({ v: 2 }));

      expect(writer.enqueue).not.toHaveBeenCalled();
    });

    it('drops a malformed frame', async () => {
      await service.handleFrame(DEVICE_ID, frame({ sid: 'not-a-uuid' }));
      await service.handleFrame(DEVICE_ID, 'not an object');

      expect(writer.enqueue).not.toHaveBeenCalled();
    });

    it('survives a registry failure rather than rejecting the event', async () => {
      // An MQTT event has no caller to receive an error; a rejection here would
      // surface as an unhandled rejection carrying the payload.
      registry.resolve.mockRejectedValue(new Error('database is down'));

      await expect(
        service.handleFrame(DEVICE_ID, frame()),
      ).resolves.toBeUndefined();
    });
  });

  describe('backfill', () => {
    it('writes a replayed batch through the same path as live frames', async () => {
      await service.handleBackfill(DEVICE_ID, {
        v: 1,
        sid: SID,
        frames: [
          frame({ seq: 1, mono: 1_000 }),
          frame({ seq: 2, mono: 1_100 }),
        ],
      });

      const [samples] = writer.enqueueAll.mock.calls[0];
      expect(samples.map((sample) => sample.seq)).toEqual([1, 2]);
      expect(samples[1].time).toEqual(new Date(ANCHOR_MS + 100));
    });

    it('ignores frames whose sid does not match the batch', async () => {
      // The batch's sid is what the session was resolved from, so a stray frame
      // would otherwise be attributed to the wrong run.
      await service.handleBackfill(DEVICE_ID, {
        v: 1,
        sid: SID,
        frames: [
          frame({ seq: 1 }),
          frame({ seq: 2, sid: '44444444-4444-4444-8444-444444444444' }),
        ],
      });

      const [samples] = writer.enqueueAll.mock.calls[0];
      expect(samples.map((sample) => sample.seq)).toEqual([1]);
    });

    it('ignores an empty batch instead of anchoring the run at zero', async () => {
      // Anchoring at mono 0 would stamp every later frame a whole device uptime
      // into the future, outside any window a reader asks for.
      await service.handleBackfill(DEVICE_ID, { v: 1, sid: SID, frames: [] });

      expect(registry.resolve).not.toHaveBeenCalled();
      expect(writer.enqueueAll).not.toHaveBeenCalled();
    });

    it('anchors on the batch first frame when the run is no longer cached', async () => {
      // Ingest restarted, or the backlog arrived hours later — either way the
      // context is rebuilt from the session row, not from now().
      await service.handleBackfill(DEVICE_ID, {
        v: 1,
        sid: SID,
        frames: [frame({ seq: 9, mono: 9_000 })],
      });

      expect(registry.resolve).toHaveBeenCalledWith(
        DEVICE_ID,
        SID,
        9_000,
        undefined,
      );
    });
  });

  describe('session lifecycle', () => {
    it('opens a session on start', async () => {
      await service.handleSessionEvent(DEVICE_ID, {
        v: 1,
        sid: SID,
        event: 'start',
        mono: 500,
        track: 'kaloyanovo',
      });

      expect(registry.resolve).toHaveBeenCalledWith(
        DEVICE_ID,
        SID,
        500,
        'kaloyanovo',
      );
    });

    it('flushes buffered samples before forgetting the run', async () => {
      // Otherwise samples built against this context would be written after it
      // is gone, or dropped with the buffer.
      await service.handleSessionEvent(DEVICE_ID, {
        v: 1,
        sid: SID,
        event: 'stop',
        mono: 900_000,
      });

      expect(sessions.closeSession).toHaveBeenCalledWith(CAR_ID, SID);
      expect(writer.flush.mock.invocationCallOrder[0]).toBeLessThan(
        registry.forget.mock.invocationCallOrder[0],
      );
    });

    it('closes against the publishing car, not the sid alone', async () => {
      // Otherwise any car could end another team's run in progress by echoing
      // their sid on its own authenticated topic.
      sessions.findCarByDeviceId.mockResolvedValue({
        id: 'the-publishing-car',
      } as never);

      await service.handleSessionEvent(DEVICE_ID, {
        v: 1,
        sid: SID,
        event: 'stop',
        mono: 900_000,
      });

      expect(sessions.closeSession).toHaveBeenCalledWith(
        'the-publishing-car',
        SID,
      );
    });

    it('ignores a stop from a device the platform does not know', async () => {
      sessions.findCarByDeviceId.mockResolvedValue(null);

      await service.handleSessionEvent(DEVICE_ID, {
        v: 1,
        sid: SID,
        event: 'stop',
        mono: 900_000,
      });

      expect(sessions.closeSession).not.toHaveBeenCalled();
    });

    it('does not open a session for a stop it never saw start', async () => {
      // Resolving here would create a zero-length session purely to close it.
      await service.handleSessionEvent(DEVICE_ID, {
        v: 1,
        sid: SID,
        event: 'stop',
        mono: 900_000,
      });

      expect(registry.resolve).not.toHaveBeenCalled();
    });
  });
});
