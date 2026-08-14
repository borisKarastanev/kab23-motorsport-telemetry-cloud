import { Injectable, WritableSignal, computed, signal } from '@angular/core';
import { Socket, io } from 'socket.io-client';
import { environment } from '../../../environments/environment';
import { LiveFrame, LiveSessionEvent, LiveState, TracePoint } from '../models/live-telemetry.model';

/**
 * Roughly five minutes of history at 10 Hz.
 *
 * The cap is not an optimisation. A manager leaves this tab open for a whole
 * track day, and an unbounded array would be 36 000 points an hour, per car,
 * re-scanned on every render. Full history is what the session telemetry
 * endpoint is for. Bounds both the GPS trace and the channel history below —
 * same rationale, same rate.
 */
const MAX_LIVE_POINTS = 3_000;

/** One CAN sample, `t` seconds elapsed since this session's first sample. */
export interface ChannelPoint {
  t: number;
  speed: number | null;
  rpm: number | null;
  coolant: number | null;
  oil: number | null;
}

@Injectable()
export class LiveTelemetryService {
  private socket: Socket | null = null;
  private carId: string | null = null;

  private readonly frame = signal<LiveFrame | null>(null);
  private readonly points = signal<TracePoint[]>([]);
  private readonly channelPoints = signal<ChannelPoint[]>([]);
  private readonly status = signal<LiveState>('idle');
  private readonly session = signal<string | null>(null);
  private readonly failure = signal<string | null>(null);

  /** `t` of this session's first sample — the origin the chart's x axis is relative to. */
  private sessionStartT: number | null = null;

  /**
   * The session the buffers currently hold data for.
   *
   * Separate from the `session` signal: that one answers "is a session
   * running" and goes null on `stop`, while this one answers "whose samples
   * are in `points`/`channelPoints`" and only changes when a genuinely
   * different session's data starts arriving.
   */
  private openSessionId: string | null = null;

  readonly latest = this.frame.asReadonly();
  readonly trace = this.points.asReadonly();
  readonly channels = this.channelPoints.asReadonly();
  readonly state = this.status.asReadonly();
  readonly error = this.failure.asReadonly();

  /** The live session id, or null between sessions — for `TrackMapService`. */
  readonly sessionId = this.session.asReadonly();
  readonly sessionActive = computed(() => this.session() !== null);

  /** Where the car is now, or null until the first frame with a fix. */
  readonly position = computed<TracePoint | null>(() => {
    const current = this.frame();
    return current?.lat != null && current?.lon != null
      ? { lat: current.lat, lon: current.lon }
      : null;
  });

  /**
   * Delivery latency: Redis → gateway → browser.
   *
   * Measured against `pt`, the publish instant, not `t`. `t` is the sample's
   * server-anchored time and carries the session's one-off anchoring offset, so
   * `now - t` reads near zero or negative and means nothing. This still says
   * nothing about the LTE hop in front of ingest, which is where the
   * glass-to-glass budget is actually spent.
   */
  readonly latencyMs = computed(() => {
    const current = this.frame();
    return current ? Date.now() - current.pt : null;
  });

  connect(carId: string): void {
    if (this.carId === carId && this.socket) {
      return;
    }

    this.disconnect();
    this.carId = carId;
    this.status.set('connecting');

    // The JWT is httpOnly, so the handshake authenticates by cookie exactly as
    // the REST calls do — the browser attaches it, this code never sees it.
    //
    // `wsUrl`, not `apiUrl`: the second argument here is a **namespace**, and
    // in production `apiUrl` is the path prefix '/api', which would ask the
    // server for a namespace called "/api/live" that does not exist.
    const socket = io(`${environment.wsUrl}/live`, {
      withCredentials: true,
    });
    this.socket = socket;

    socket.on('connect', () => {
      this.status.set('connected');
      this.failure.set(null);
      // Re-sent on every connect, not just the first: a reconnect starts a new
      // session on the server with no memory of what this client was watching.
      socket.emit('subscribe', { carId });
    });

    socket.on('frame', (payload: LiveFrame) => this.onFrame(payload));
    socket.on('event', (payload: LiveSessionEvent) => this.onEvent(payload));

    socket.on('error', (payload: { message?: string }) => {
      this.failure.set(payload?.message ?? 'Live feed error');
      this.status.set('error');
    });

    socket.on('disconnect', () => {
      if (this.status() !== 'error') {
        this.status.set('disconnected');
      }
    });

    socket.on('connect_error', () => {
      this.failure.set('Could not reach the live feed');
      this.status.set('error');
    });
  }

  disconnect(): void {
    if (this.socket) {
      // Handlers removed before closing, or a queued 'disconnect' would write
      // state for a car the caller has already moved on from.
      this.socket.removeAllListeners();
      this.socket.disconnect();
      this.socket = null;
    }

    this.carId = null;
    this.frame.set(null);
    this.points.set([]);
    this.channelPoints.set([]);
    this.sessionStartT = null;
    // Unlike `stop`, this really is a full teardown: the next car's first
    // frame must re-anchor even if it happens to belong to the same session.
    this.openSessionId = null;
    this.session.set(null);
    this.failure.set(null);
    this.status.set('idle');
  }

  private onFrame(payload: LiveFrame): void {
    // A viewer that joined mid-session never saw its `start` event, so the
    // first frame observed is the only origin available — and a frame can
    // also simply beat the `start` event here. Either way this is what
    // anchors the buffers to the right session; see `beginSessionIfNew`.
    this.beginSessionIfNew(payload.sessionId, payload.t);

    this.frame.set(payload);
    this.session.set(payload.sessionId);

    appendCapped(this.channelPoints, {
      t: (payload.t - this.sessionStartT!) / 1000,
      speed: payload.speed ?? null,
      rpm: payload.rpm ?? null,
      coolant: payload.coolant ?? null,
      oil: payload.oil ?? null,
    });

    if (payload.lat == null || payload.lon == null) {
      // No fix yet — CAN data is still worth showing on the gauges, but a
      // (0, 0) point would drag the trace's bounds into the Atlantic.
      return;
    }

    appendCapped(this.points, { lat: payload.lat!, lon: payload.lon! });
  }

  private onEvent(payload: LiveSessionEvent): void {
    if (payload.event === 'start') {
      // Keyed on the session, not on the event: a device that did not see its
      // PUBACK re-publishes `start`, and ingest answers a repeated `sid` with
      // the *existing* session — so this arrives more than once for one run.
      // Clearing unconditionally would blank a watching manager's map every
      // time the car's uplink retried. Devices are expected to re-send.
      this.beginSessionIfNew(payload.sessionId, payload.t);
      this.session.set(payload.sessionId);
      return;
    }

    // `openSessionId` deliberately survives `stop`: it identifies whose data
    // the buffers hold, not whether a session is running. Clearing it here
    // would make a straggler frame arriving after `stop` look like a brand
    // new session and wipe the trace a viewer is still looking at.
    this.session.set(null);
  }

  /**
   * Reset the buffers onto a new session, if this id is not the one they
   * already hold.
   *
   * Called from **both** `onFrame` and the `start` event because the two
   * arrive on different Redis channels and so have no guaranteed order. When
   * a frame wins the race, this is what stops the new session's samples being
   * appended to the previous session's — which for the charts also means
   * appended against the previous session's `t` origin, putting the whole
   * visible window hours wide and squashing the live trace into a sliver at
   * the right edge until the 5-minute buffer rolled over.
   */
  private beginSessionIfNew(sessionId: string, startT: number): void {
    if (sessionId === this.openSessionId) {
      return;
    }

    this.openSessionId = sessionId;
    this.sessionStartT = startT;
    this.points.set([]);
    this.channelPoints.set([]);
  }
}

/**
 * Append one point to a bounded rolling buffer.
 *
 * Trimmed on the way in rather than after appending: at the cap, growing then
 * slicing copies the whole 3 000-point array twice per frame, ten times a
 * second, for one new point. Shared by the GPS trace and the channel history
 * so the two cannot end up with different caps or different trim behaviour.
 */
function appendCapped<T>(buffer: WritableSignal<T[]>, point: T): void {
  buffer.update((existing) => {
    const next = existing.slice(Math.max(0, existing.length - MAX_LIVE_POINTS + 1));
    next.push(point);
    return next;
  });
}
