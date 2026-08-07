import { Injectable, computed, signal } from '@angular/core';
import { Socket, io } from 'socket.io-client';
import { environment } from '../../../environments/environment';
import {
  LiveFrame,
  LiveSessionEvent,
  LiveState,
  TracePoint,
} from '../models/live-telemetry.model';

/**
 * Roughly five minutes of trace at 10 Hz.
 *
 * The cap is not an optimisation. A manager leaves this tab open for a whole
 * track day, and an unbounded array would be 36 000 points an hour, per car,
 * re-scanned on every render. Full history is what the session telemetry
 * endpoint is for.
 */
const MAX_TRACE_POINTS = 3_000;

@Injectable()
export class LiveTelemetryService {
  private socket: Socket | null = null;
  private carId: string | null = null;

  private readonly frame = signal<LiveFrame | null>(null);
  private readonly points = signal<TracePoint[]>([]);
  private readonly status = signal<LiveState>('idle');
  private readonly session = signal<string | null>(null);
  private readonly failure = signal<string | null>(null);

  readonly latest = this.frame.asReadonly();
  readonly trace = this.points.asReadonly();
  readonly state = this.status.asReadonly();
  readonly error = this.failure.asReadonly();

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
    this.session.set(null);
    this.failure.set(null);
    this.status.set('idle');
  }

  private onFrame(payload: LiveFrame): void {
    this.frame.set(payload);
    this.session.set(payload.sessionId);

    if (payload.lat == null || payload.lon == null) {
      // No fix yet — CAN data is still worth showing on the gauges, but a
      // (0, 0) point would drag the trace's bounds into the Atlantic.
      return;
    }

    this.points.update((existing) => {
      // Trimmed on the way in rather than after appending: at the cap, growing
      // then slicing copies the whole 3 000-point array twice per frame, ten
      // times a second, for one new point.
      const from = Math.max(0, existing.length - MAX_TRACE_POINTS + 1);
      const next = existing.slice(from);
      next.push({ lat: payload.lat!, lon: payload.lon! });
      return next;
    });
  }

  private onEvent(payload: LiveSessionEvent): void {
    if (payload.event === 'start') {
      // Keyed on the session, not on the event: a device that did not see its
      // PUBACK re-publishes `start`, and ingest answers a repeated `sid` with
      // the *existing* session — so this arrives more than once for one run.
      // Clearing unconditionally would blank a watching manager's map every
      // time the car's uplink retried. Devices are expected to re-send.
      if (payload.sessionId !== this.session()) {
        this.points.set([]);
        this.session.set(payload.sessionId);
      }
      return;
    }

    this.session.set(null);
  }
}
