import { io } from 'socket.io-client';

import { LiveTelemetryService } from './live-telemetry.service';
import { LiveFrame, LiveSessionEvent } from '../models/live-telemetry.model';
import { environment } from '../../../environments/environment';

vi.mock('socket.io-client', () => ({ io: vi.fn() }));

function makeFrame(overrides: Partial<LiveFrame> = {}): LiveFrame {
  return {
    v: 1,
    sessionId: 'session-1',
    carId: 'car-1',
    t: 1000,
    pt: Date.now(),
    seq: 1,
    ...overrides,
  };
}

/** A minimal stand-in for a socket.io `Socket` — captures handlers so tests can fire them. */
function createFakeSocket() {
  const handlers = new Map<string, (payload?: unknown) => void>();
  return {
    on: vi.fn((event: string, handler: (payload?: unknown) => void) => {
      handlers.set(event, handler);
    }),
    emit: vi.fn(),
    removeAllListeners: vi.fn(),
    disconnect: vi.fn(),
    trigger(event: string, payload?: unknown) {
      handlers.get(event)?.(payload);
    },
  };
}

describe('LiveTelemetryService', () => {
  let service: LiveTelemetryService;
  let ioMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    ioMock = io as unknown as ReturnType<typeof vi.fn>;
    ioMock.mockReset();
    service = new LiveTelemetryService();
  });

  it('starts idle with empty buffers', () => {
    expect(service.state()).toBe('idle');
    expect(service.latest()).toBeNull();
    expect(service.trace()).toEqual([]);
    expect(service.channels()).toEqual([]);
    expect(service.sessionActive()).toBe(false);
    expect(service.position()).toBeNull();
    expect(service.latencyMs()).toBeNull();
  });

  it('connects to the /live namespace with credentials and subscribes on connect', () => {
    const socket = createFakeSocket();
    ioMock.mockReturnValue(socket);

    service.connect('car-1');

    expect(ioMock).toHaveBeenCalledWith(`${environment.wsUrl}/live`, {
      withCredentials: true,
    });
    expect(service.state()).toBe('connecting');

    socket.trigger('connect');

    expect(service.state()).toBe('connected');
    expect(socket.emit).toHaveBeenCalledWith('subscribe', { carId: 'car-1' });
  });

  it('re-subscribes on every reconnect, not just the first', () => {
    const socket = createFakeSocket();
    ioMock.mockReturnValue(socket);

    service.connect('car-1');
    socket.trigger('connect');
    socket.trigger('connect');

    expect(socket.emit).toHaveBeenNthCalledWith(1, 'subscribe', { carId: 'car-1' });
    expect(socket.emit).toHaveBeenNthCalledWith(2, 'subscribe', { carId: 'car-1' });
  });

  it('is a no-op when asked to connect to the car it is already on', () => {
    const socket = createFakeSocket();
    ioMock.mockReturnValue(socket);

    service.connect('car-1');
    service.connect('car-1');

    expect(ioMock).toHaveBeenCalledTimes(1);
  });

  it('tears down the old socket before opening a new one for a different car', () => {
    const first = createFakeSocket();
    const second = createFakeSocket();
    ioMock.mockReturnValueOnce(first).mockReturnValueOnce(second);

    service.connect('car-1');
    service.connect('car-2');

    expect(first.removeAllListeners).toHaveBeenCalled();
    expect(first.disconnect).toHaveBeenCalled();
    expect(ioMock).toHaveBeenCalledTimes(2);
  });

  it('surfaces a socket error and moves to the error state', () => {
    const socket = createFakeSocket();
    ioMock.mockReturnValue(socket);

    service.connect('car-1');
    socket.trigger('error', { message: 'nope' });

    expect(service.error()).toBe('nope');
    expect(service.state()).toBe('error');
  });

  it('falls back to a generic message when the error event carries none', () => {
    const socket = createFakeSocket();
    ioMock.mockReturnValue(socket);

    service.connect('car-1');
    socket.trigger('error', {});

    expect(service.error()).toBe('Live feed error');
  });

  it('reports connect_error as a reachability failure', () => {
    const socket = createFakeSocket();
    ioMock.mockReturnValue(socket);

    service.connect('car-1');
    socket.trigger('connect_error');

    expect(service.error()).toBe('Could not reach the live feed');
    expect(service.state()).toBe('error');
  });

  it('moves to disconnected on a plain disconnect', () => {
    const socket = createFakeSocket();
    ioMock.mockReturnValue(socket);

    service.connect('car-1');
    socket.trigger('connect');
    socket.trigger('disconnect');

    expect(service.state()).toBe('disconnected');
  });

  it('does not downgrade an error state on a trailing disconnect event', () => {
    const socket = createFakeSocket();
    ioMock.mockReturnValue(socket);

    service.connect('car-1');
    socket.trigger('connect_error');
    socket.trigger('disconnect');

    expect(service.state()).toBe('error');
  });

  describe('frames', () => {
    let socket: ReturnType<typeof createFakeSocket>;

    beforeEach(() => {
      socket = createFakeSocket();
      ioMock.mockReturnValue(socket);
      service.connect('car-1');
    });

    it('stores the latest frame and derives position from lat/lon', () => {
      socket.trigger('frame', makeFrame({ lat: 41.1, lon: 23.5 }));

      expect(service.latest()?.lat).toBe(41.1);
      expect(service.position()).toEqual({ lat: 41.1, lon: 23.5 });
      expect(service.sessionId()).toBe('session-1');
      expect(service.sessionActive()).toBe(true);
    });

    it('does not append a trace point while there is no GPS fix yet', () => {
      socket.trigger('frame', makeFrame({ lat: undefined, lon: undefined }));

      expect(service.position()).toBeNull();
      expect(service.trace()).toEqual([]);
      // The gauges still get the CAN data even with no fix.
      expect(service.channels()).toHaveLength(1);
    });

    it('maps channel fields onto the bounded channel history, t relative to session start', () => {
      socket.trigger('frame', makeFrame({ t: 1000, speed: 180, rpm: 6000, coolant: 92, oil: 4.1 }));
      socket.trigger('frame', makeFrame({ t: 1500, speed: 185, rpm: 6100, coolant: 92, oil: 4.1 }));

      expect(service.channels()).toEqual([
        { t: 0, speed: 180, rpm: 6000, coolant: 92, oil: 4.1 },
        { t: 0.5, speed: 185, rpm: 6100, coolant: 92, oil: 4.1 },
      ]);
    });

    it('computes latency against the publish time, not the sample time', () => {
      const now = Date.now();
      vi.spyOn(Date, 'now').mockReturnValue(now);

      socket.trigger('frame', makeFrame({ pt: now - 250 }));

      expect(service.latencyMs()).toBe(250);
      vi.restoreAllMocks();
    });

    it('resets the buffers when a frame arrives for a new session', () => {
      socket.trigger('frame', makeFrame({ sessionId: 'session-1', t: 1000, lat: 1, lon: 1 }));
      socket.trigger('frame', makeFrame({ sessionId: 'session-1', t: 1200, lat: 2, lon: 2 }));
      expect(service.trace()).toHaveLength(2);

      socket.trigger('frame', makeFrame({ sessionId: 'session-2', t: 5000, lat: 3, lon: 3 }));

      // The new session's frame re-anchors the buffers rather than appending.
      expect(service.trace()).toEqual([{ lat: 3, lon: 3 }]);
      expect(service.channels()).toEqual([{ t: 0, speed: null, rpm: null, coolant: null, oil: null }]);
    });

    it('caps the trace buffer at 3000 points, dropping the oldest first', () => {
      for (let i = 0; i < 3005; i++) {
        socket.trigger(
          'frame',
          makeFrame({ t: 1000 + i, lat: i, lon: i, seq: i }),
        );
      }

      const trace = service.trace();
      expect(trace).toHaveLength(3000);
      // The first 5 points (lat 0..4) were pushed out.
      expect(trace[0]).toEqual({ lat: 5, lon: 5 });
      expect(trace[trace.length - 1]).toEqual({ lat: 3004, lon: 3004 });
    });
  });

  describe('session events', () => {
    let socket: ReturnType<typeof createFakeSocket>;

    beforeEach(() => {
      socket = createFakeSocket();
      ioMock.mockReturnValue(socket);
      service.connect('car-1');
    });

    const startEvent = (overrides: Partial<LiveSessionEvent> = {}): LiveSessionEvent => ({
      v: 1,
      carId: 'car-1',
      sessionId: 'session-1',
      event: 'start',
      t: 1000,
      ...overrides,
    });

    it('sets the session id on start and anchors the buffers', () => {
      socket.trigger('event', startEvent());

      expect(service.sessionId()).toBe('session-1');
      expect(service.sessionActive()).toBe(true);
    });

    it('tolerates a repeated start for the same session without wiping data', () => {
      socket.trigger('event', startEvent());
      socket.trigger('frame', makeFrame({ sessionId: 'session-1', t: 1000, lat: 1, lon: 1 }));
      expect(service.trace()).toHaveLength(1);

      // A device that never saw its PUBACK re-sends `start`.
      socket.trigger('event', startEvent());

      expect(service.trace()).toHaveLength(1);
    });

    it('clears the active session on stop but keeps the buffered data', () => {
      socket.trigger('event', startEvent());
      socket.trigger('frame', makeFrame({ sessionId: 'session-1', t: 1000, lat: 1, lon: 1 }));

      socket.trigger('event', { ...startEvent(), event: 'stop' });

      expect(service.sessionActive()).toBe(false);
      expect(service.sessionId()).toBeNull();
      // A late frame is not mistaken for a brand new session.
      expect(service.trace()).toHaveLength(1);
    });
  });

  describe('disconnect()', () => {
    it('tears the socket down and resets all state to idle', () => {
      const socket = createFakeSocket();
      ioMock.mockReturnValue(socket);

      service.connect('car-1');
      socket.trigger('connect');
      socket.trigger('frame', makeFrame({ lat: 1, lon: 1 }));

      service.disconnect();

      expect(socket.removeAllListeners).toHaveBeenCalled();
      expect(socket.disconnect).toHaveBeenCalled();
      expect(service.state()).toBe('idle');
      expect(service.latest()).toBeNull();
      expect(service.trace()).toEqual([]);
      expect(service.channels()).toEqual([]);
      expect(service.sessionId()).toBeNull();
      expect(service.error()).toBeNull();
    });

    it('is a safe no-op when called with no active connection', () => {
      expect(() => service.disconnect()).not.toThrow();
    });

    it('re-anchors even for the same session id after a full disconnect', () => {
      const first = createFakeSocket();
      const second = createFakeSocket();
      ioMock.mockReturnValueOnce(first).mockReturnValueOnce(second);

      service.connect('car-1');
      first.trigger('frame', makeFrame({ sessionId: 'session-1', t: 1000, lat: 1, lon: 1 }));
      expect(service.trace()).toHaveLength(1);

      service.disconnect();
      service.connect('car-1');
      second.trigger('frame', makeFrame({ sessionId: 'session-1', t: 9000, lat: 2, lon: 2 }));

      // Unlike `stop`, a full teardown forgets which session it held data for.
      expect(service.trace()).toEqual([{ lat: 2, lon: 2 }]);
    });
  });
});
