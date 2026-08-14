import { Injectable, computed, effect, signal } from '@angular/core';
import { httpResource } from '@angular/common/http';
import { environment } from '../../../environments/environment';
import { TrackMapResponse } from '../models/track-map.model';
import { guarded } from '../resource';

/** A cold track's first fetch is a few seconds; this covers a slow one. */
const MAX_PENDING_RETRIES = 3;
const RETRY_DELAY_MS = 5000;

/**
 * A circuit's outline, for drawing under a racing line.
 *
 * **Root-provided, like `CarsService`**, not per-view like `LapAnalysisService`:
 * the analysis view and the live view both want the same thing — the outline
 * for whatever track is currently on screen — and only one of those views is
 * ever open at a time, so one instance keyed on a settable `track` is enough.
 * Call `open(track)` with the session's `track` string (or `null` to idle);
 * changing it re-requests, same as `LapAnalysisService.open(sessionId)`.
 *
 * **The API can answer `pending`** — the first request for a track a fetch is
 * already underway for, or one that outran the server's own fetch deadline.
 * `retryTick` exists so that state does not become a dead end: bumping it
 * forces `httpResource`'s request object to a new reference, which is what
 * makes it re-request the *same* URL rather than sitting on a `pending`
 * response forever. Capped at `MAX_PENDING_RETRIES`, because a track OSM
 * cannot place should settle into `unavailable`, not poll forever.
 *
 * **Failure here must always degrade to "no overlay", never to a broken view.**
 * `GET /tracks/:track/map` answers 404 whenever the track string does not
 * resolve, which `TracksService.resolve` is explicit is "a first-class answer,
 * not a failure" — a car reports whatever its independently-versioned on-car
 * database calls the track. So the error state is one this feature produces on
 * purpose, and the read goes through `guarded` (see `core/resource.ts`) for the
 * reason documented there.
 */
@Injectable({ providedIn: 'root' })
export class TrackMapService {
  private readonly track = signal<string | null>(null);
  private readonly retryTick = signal(0);
  private retryCount = 0;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;

  private readonly resource = httpResource<TrackMapResponse>(() => {
    const track = this.track();
    // Read so this recomputes — and returns a new request object, which is
    // what triggers a re-fetch — every time a retry is due.
    this.retryTick();

    if (!track) {
      return undefined;
    }

    return {
      url: `${environment.apiUrl}/tracks/${encodeURIComponent(track)}/map`,
      withCredentials: true,
    };
  });

  /**
   * The response, or `null` when there is not one to read — idle, loading, or
   * errored. The single gate every public signal below reads through.
   */
  private readonly response = guarded(this.resource);

  readonly status = computed(() => this.response()?.status ?? null);

  /** The circuit + corner features, or null until they are actually ready. */
  readonly map = computed(() => {
    const result = this.response();
    return result?.status === 'ready' ? (result.map ?? null) : null;
  });

  readonly attribution = computed(() => this.response()?.attribution ?? null);

  // ---------------------------------------------------------------------------
  // Resolving a session to its track
  // ---------------------------------------------------------------------------

  /**
   * Both views arrive holding a *session* id, not a track, so both used to
   * fetch `GET /sessions/:id` themselves purely to read one string off it —
   * once in `LapAnalysisService`, once inlined in the live component, which put
   * an `httpResource` in the component layer that nothing else in this app
   * does. It lives here instead: this service is root-provided and already
   * shared by both views, so it is the one object both callers already hold.
   */
  private readonly sessionId = signal<string | null>(null);

  private readonly sessionResource = httpResource<{ track: string }>(() => {
    const id = this.sessionId();
    return id ? { url: `${environment.apiUrl}/sessions/${id}`, withCredentials: true } : undefined;
  });

  private readonly session = guarded(this.sessionResource);

  constructor() {
    effect(() => {
      const status = this.response()?.status;

      if (status === 'pending') {
        this.scheduleRetry();
        return;
      }

      if (status) {
        // A settled, non-pending answer — `ready` or `unavailable` — ends this
        // track's retry run and restores the budget, so a later `pending` on
        // the same track is not silently refused by an exhausted counter.
        this.retryCount = 0;
        this.clearRetry();
      }

      // Otherwise there is no answer to act on: idle, loading, or errored.
      // Crucially that includes the loading window of each retry — the
      // resource has no `defaultValue`, so `response()` is null between
      // firing a retry and its reply landing. Resetting the budget here would
      // zero the counter on every retry and poll forever.
    });

    // A session's track arrives asynchronously; feed it through the same
    // `open` path an explicit caller uses, so the retry budget and the
    // no-op-on-same-track check behave identically either way.
    //
    // Gated on there *being* a session, or this would fight `open()`: with no
    // session the read is idle, `session()` is null, and an ungated effect
    // would drive `open(null)` on every tick and undo the caller's own choice
    // of track.
    effect(() => {
      if (this.sessionId() === null) {
        return;
      }
      this.open(this.session()?.track ?? null);
    });
  }

  /**
   * Show the outline for whatever track a *session* was run on, resolving the
   * session itself. `null` idles both reads — which is also how a view hands
   * this root-provided service back on teardown.
   */
  openForSession(sessionId: string | null): void {
    this.sessionId.set(sessionId);

    if (sessionId === null) {
      this.open(null);
    }
  }

  /** Which track to show the outline for; `null` idles the resource. */
  open(track: string | null): void {
    if (track === this.track()) {
      return;
    }

    this.retryCount = 0;
    this.clearRetry();
    this.track.set(track);
  }

  private scheduleRetry(): void {
    if (this.retryTimer || this.retryCount >= MAX_PENDING_RETRIES) {
      return;
    }

    this.retryCount++;
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      this.retryTick.update((n) => n + 1);
    }, RETRY_DELAY_MS);
  }

  private clearRetry(): void {
    if (this.retryTimer) {
      clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
  }
}
