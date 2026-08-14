import { Injectable, computed, inject, signal } from '@angular/core';
import { HttpClient, httpResource } from '@angular/common/http';
import { firstValueFrom } from 'rxjs';
import { environment } from '../../../environments/environment';
import { Lap, LapCompare, LapTrace, LapsResponse } from '../models/analysis.model';
import { guarded } from '../resource';

/**
 * Enough points to draw a corner faithfully, few enough that switching laps is
 * instant. At 800 points over a 2 100 m lap the spacing is 2.6 m — well inside
 * what an inline SVG at screen size can resolve.
 */
const TRACE_POINTS = 800;

/** One point per ~2 px of a wide chart; more is invisible. */
const DELTA_POINTS = 600;

/**
 * One session's analysis: laps, the selected lap's trace, and the comparison.
 *
 * **Provided per view, not in root** — the same choice `LiveTelemetryService`
 * makes. It holds the selection for one session, so a root-provided instance
 * would carry lap 3 of yesterday's session into today's.
 *
 * Every read is an `httpResource` keyed on a signal, so changing the selected
 * lap re-requests without anything imperative: the URL is a function of the
 * state, which is the whole reason the codebase prefers `httpResource` for
 * request-shaped reads. Nothing here returns an Observable and nothing
 * subscribes.
 */
@Injectable()
export class LapAnalysisService {
  private readonly http = inject(HttpClient);
  private readonly base = environment.apiUrl;

  private readonly sessionId = signal<string | null>(null);
  private readonly selected = signal<number | null>(null);
  private readonly compareWith = signal<number | null>(null);

  // ---------------------------------------------------------------------------
  // Laps
  // ---------------------------------------------------------------------------

  private readonly lapsResource = httpResource<LapsResponse>(() => {
    const id = this.sessionId();
    // `undefined` leaves the resource idle. Without this the view would fire a
    // request at `/sessions/null/laps` on its first change detection.
    return id ? { url: `${this.base}/sessions/${id}/laps`, withCredentials: true } : undefined;
  });

  /**
   * The gate every laps read below goes through. Worth knowing why it is not
   * optional here: the analysis topbar binds `analyzedAt()` *above* the
   * template's `@else if (analysis.error())` branch, so an unguarded read threw
   * during change detection and took the view down instead of rendering the
   * error state that already exists for exactly this case. See
   * `core/resource.ts`.
   */
  private readonly lapsResponse = guarded(this.lapsResource);

  readonly laps = computed<Lap[]>(() => this.lapsResponse()?.laps ?? []);
  readonly analyzedAt = computed(() => this.lapsResponse()?.analyzedAt ?? null);
  /**
   * Why the last derivation produced nothing.
   *
   * Normally set only when `laps` is empty; a forced recompute that could not
   * run keeps the laps it already had and returns both. So read it as "why
   * there is nothing *new*", and gate empty states on `laps().length`.
   */
  readonly reason = computed(() => this.lapsResponse()?.reason ?? null);
  readonly loading = this.lapsResource.isLoading;
  readonly error = this.lapsResource.error;

  readonly bestLap = computed(() => this.laps().find((lap) => lap.isBest)?.lapNumber ?? null);

  /**
   * The lap being looked at.
   *
   * Derived rather than synced by an effect: until the user picks one, the
   * answer *is* the best lap, and writing that into `selected` when the laps
   * arrive would then have to be undone when they change.
   */
  readonly activeLap = computed(() => this.selected() ?? this.bestLap());

  /**
   * The lap drawn underneath — the explicit comparison if there is one, and
   * otherwise the session's best.
   *
   * Defaulting to the best lap is what makes the view useful the moment it
   * opens: select any lap and you are immediately looking at where it lost time
   * to the quickest one, with no second selection to make. Null when that would
   * mean comparing a lap against itself.
   */
  readonly referenceLap = computed(() => {
    const active = this.activeLap();
    const explicit = this.compareWith();

    if (explicit != null) {
      return explicit === active ? null : explicit;
    }

    const best = this.bestLap();
    return best != null && best !== active ? best : null;
  });

  readonly activeLapRow = computed(() =>
    this.laps().find((lap) => lap.lapNumber === this.activeLap()),
  );

  // ---------------------------------------------------------------------------
  // Traces
  // ---------------------------------------------------------------------------

  private readonly activeTraceResource = httpResource<LapTrace>(() =>
    this.traceRequest(this.activeLap()),
  );

  private readonly referenceTraceResource = httpResource<LapTrace>(() =>
    this.traceRequest(this.referenceLap()),
  );

  private readonly compareResource = httpResource<LapCompare>(() => {
    const id = this.sessionId();
    const a = this.activeLap();
    const b = this.referenceLap();

    return id && a != null && b != null
      ? {
          url: `${this.base}/sessions/${id}/compare`,
          // The API takes `?laps=a,b` and validates exactly two.
          params: { laps: `${a},${b}`, maxPoints: DELTA_POINTS },
          withCredentials: true,
        }
      : undefined;
  });

  // A trace 404s for a lap the derivation dropped on a recompute, and all
  // three inherit the laps request's 401. A missing trace must render as no
  // line, never as a thrown view.
  readonly activeTrace = guarded(this.activeTraceResource);
  readonly referenceTrace = guarded(this.referenceTraceResource);
  readonly compare = guarded(this.compareResource);
  readonly traceLoading = computed(
    () => this.activeTraceResource.isLoading() || this.referenceTraceResource.isLoading(),
  );

  private traceRequest(lapNumber: number | null) {
    const id = this.sessionId();

    return id && lapNumber != null
      ? {
          url: `${this.base}/sessions/${id}/laps/${lapNumber}/trace`,
          params: { maxPoints: TRACE_POINTS },
          withCredentials: true,
        }
      : undefined;
  }

  // ---------------------------------------------------------------------------
  // Commands
  // ---------------------------------------------------------------------------

  /**
   * Point the view at a session.
   *
   * Clears the selection, because lap 3 of the previous session is not lap 3 of
   * this one — and a stale selection would fire a trace request for a lap that
   * may not exist.
   */
  open(sessionId: string): void {
    if (this.sessionId() === sessionId) {
      return;
    }

    this.sessionId.set(sessionId);
    this.selected.set(null);
    this.compareWith.set(null);
  }

  select(lapNumber: number): void {
    this.selected.set(lapNumber);
    // A comparison against the lap now being viewed is not a comparison.
    if (this.compareWith() === lapNumber) {
      this.compareWith.set(null);
    }
  }

  /** Toggle: picking the lap already being compared clears the comparison. */
  toggleCompare(lapNumber: number): void {
    this.compareWith.update((current) => (current === lapNumber ? null : lapNumber));
  }

  /**
   * Force a re-derivation — for a corrected track gate, or when the device's
   * own lap count disagrees with ours.
   *
   * `firstValueFrom` at the boundary and a signal out, per the frontend's hard
   * rule; the response is discarded in favour of reloading the resource, so the
   * laps signal has exactly one writer.
   */
  async recompute(): Promise<void> {
    const id = this.sessionId();
    if (!id) {
      return;
    }

    await firstValueFrom(
      this.http.post<LapsResponse>(
        `${this.base}/sessions/${id}/analyze`,
        {},
        { withCredentials: true },
      ),
    );

    this.lapsResource.reload();
    this.activeTraceResource.reload();
    this.referenceTraceResource.reload();
    this.compareResource.reload();
  }
}
