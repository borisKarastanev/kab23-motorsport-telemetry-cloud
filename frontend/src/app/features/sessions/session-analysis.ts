import { Component, DestroyRef, computed, effect, inject, input, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import { LapAnalysisService } from '../../core/services/lap-analysis.service';
import { TrackMapService } from '../../core/services/track-map.service';
import { AnalysisSkipReason, LapRef } from '../../core/models/analysis.model';
import { CHANNEL_COLOUR, ChartSeries, LineChart } from '../../core/charts/line-chart';
import { LapPicker } from './lap-picker';
import { LapTable } from './lap-table';
import { RacingLine } from './racing-line';
import { lapTime, refLabel, signedSeconds } from './format';

/**
 * What each empty state means, in a driver's terms.
 *
 * The API answers 200 with a reason rather than an error for all of these, so
 * the view can say which one it is. "No laps" on its own would send someone
 * looking for a bug in four different places.
 */
const REASONS: Record<AnalysisSkipReason, string> = {
  'session-live': 'This session is still running. Laps are derived once it closes.',
  'no-track-gate':
    'No start/finish line on record for this track, so laps cannot be derived. ' +
    'The track a car reports comes from its own database, which is versioned ' +
    'independently of this platform.',
  'no-samples': 'This session recorded no telemetry.',
  'no-crossings':
    'The car never crossed the start/finish line for this track. Either no lap ' +
    'was completed, or the session was run somewhere other than the track it ' +
    'reports.',
  'too-many-samples':
    'This session is too long to analyze in one request. It needs the offline ' +
    'analysis worker.',
};

/**
 * The driver analysis view: where the time went.
 *
 * The session id is a route input, so the store follows the URL rather than the
 * other way round — the same arrangement the live view uses for `:carId`, and
 * what makes one lap of one session a bookmarkable thing.
 */
@Component({
  selector: 'app-session-analysis',
  imports: [LapPicker, LapTable, LineChart, RacingLine, RouterLink],
  templateUrl: './session-analysis.html',
  styleUrl: './session-analysis.scss',
  // One store per view: it holds the selection for one session.
  providers: [LapAnalysisService],
})
export class SessionAnalysis {
  protected readonly analysis = inject(LapAnalysisService);
  protected readonly trackMap = inject(TrackMapService);

  /** The `:id` route segment, bound by `withComponentInputBinding()`. */
  readonly id = input.required<string>();

  protected readonly recomputing = signal(false);
  protected readonly recomputeError = signal<string | null>(null);

  constructor() {
    effect(() => this.analysis.open(this.id()));
    // `TrackMapService` is root-provided and shared with the live view, so it
    // must be told what to show; it resolves the session to its track itself.
    effect(() => this.trackMap.openForSession(this.id()));
    // Root-provided means it outlives this view. Without this, leaving the
    // page mid-`pending` leaves a retry timer armed for a component that no
    // longer exists, and the departed track's outline stays in memory.
    inject(DestroyRef).onDestroy(() => this.trackMap.openForSession(null));
  }

  /**
   * Keyed on there being no laps, not on there being a reason: a forced
   * recompute that could not run answers with the reason *and* the laps it
   * kept, and those laps are still worth drawing.
   */
  protected readonly emptyMessage = computed(() => {
    const reason = this.analysis.reason();
    return reason && !this.analysis.laps().length ? REASONS[reason] : null;
  });

  protected readonly activeLabel = computed(() => refLabel(this.analysis.activeLap()));
  protected readonly referenceLabel = computed(() => refLabel(this.analysis.referenceLap()));
  /** The lowercase mid-sentence forms, for "… vs lap 9" / "… vs Optimal". */
  protected readonly activeLabelLower = computed(() => refLabel(this.analysis.activeLap(), false));
  protected readonly referenceLabelLower = computed(() =>
    refLabel(this.analysis.referenceLap(), false),
  );

  /**
   * Lap time and how it compares, for the header.
   *
   * `lapMsFor` reads either a numbered lap's own `lapMs` or the optimal's
   * summed one, so the header, the delta and the chart legends all agree on
   * what "the active lap's time" means once `activeLap()` can be `'optimal'`
   * — nobody drove it, but it still has a time to compare against.
   */
  protected readonly headline = computed(() => {
    const activeRef = this.analysis.activeLap();
    const activeMs = this.lapMsFor(activeRef);
    if (activeMs == null) {
      return null;
    }

    const referenceRef = this.analysis.referenceLap();
    const referenceMs = this.lapMsFor(referenceRef);

    return {
      time: lapTime(activeMs),
      // Nobody drove the optimal lap, so it is never the "Fastest" pill —
      // that pill means an actual lap beat every other actual lap.
      isBest: activeRef !== 'optimal' && (this.analysis.activeLapRow()?.isBest ?? false),
      delta: referenceMs != null ? signedSeconds(activeMs - referenceMs) : null,
      referenceLap: referenceRef,
    };
  });

  private lapMsFor(ref: LapRef | null): number | null {
    if (ref == null) {
      return null;
    }
    if (ref === 'optimal') {
      return this.analysis.optimal()?.lapMs ?? null;
    }
    return this.analysis.laps().find((lap) => lap.lapNumber === ref)?.lapMs ?? null;
  }

  /** Whether the optimal lap is drawn anywhere — as the primary or the ghost. */
  protected readonly optimalOnScreen = computed(
    () => this.analysis.activeLap() === 'optimal' || this.analysis.referenceLap() === 'optimal',
  );

  /**
   * The map key's optimal-lap line: which lap set each sector, and — on a
   * legacy (distance-fraction) session — the seam caveat gate-derived
   * sessions do not need. `null` whenever the optimal lap is not on screen.
   */
  protected readonly optimalCaption = computed(() => {
    const optimal = this.analysis.optimal();
    if (!optimal || !this.optimalOnScreen()) {
      return null;
    }

    const provenance = optimal.sectors
      .map((sector, i) => `S${i + 1} lap ${sector.lapNumber}`)
      .join(' · ');

    if (this.analysis.sectorScheme() === 'gates') {
      return `Optimal — ${provenance}`;
    }

    const seams = this.analysis.seams();
    const maxGapM = seams.length ? Math.max(...seams.map((seam) => seam.gapM)) : 0;
    const caveat =
      maxGapM > 30
        ? `sector boundaries are approximate on this legacy session — seam gap up to ${maxGapM.toFixed(0)} m`
        : 'sector boundaries are approximate on this legacy session';

    return `Optimal — ${provenance} — ${caveat}`;
  });

  // ---------------------------------------------------------------------------
  // Chart series
  // ---------------------------------------------------------------------------

  /** One name per series, used by both the template and the series builders. */
  protected readonly activePoints = computed(() => this.analysis.activeTrace()?.points ?? []);
  protected readonly referencePoints = computed(() => this.analysis.referenceTrace()?.points ?? []);

  protected readonly brakingPoints = computed(() =>
    this.analysis.activeLap() === 'optimal'
      ? (this.analysis.optimal()?.brakingPoints ?? [])
      : (this.analysis.activeLapRow()?.brakingPoints ?? []),
  );

  protected readonly speedSeries = computed(() => this.channel((point) => point.speedKmh));
  protected readonly rpmSeries = computed(() => this.channel((point) => point.rpm));
  protected readonly tempSeries = computed<ChartSeries[]>(() => {
    const points = this.activePoints();

    // Temperatures are the one pair that belongs on a shared axis, and they are
    // a property of the *car over the session*, not of a lap — so this chart
    // shows the active lap only. Overlaying a reference lap's coolant trace
    // would suggest a comparison nobody makes.
    return [
      {
        label: 'Coolant',
        colour: CHANNEL_COLOUR.coolant,
        points: points.map((p) => ({ x: p.distM, y: p.coolantC })),
      },
      {
        label: 'Oil',
        colour: CHANNEL_COLOUR.oil,
        points: points.map((p) => ({ x: p.distM, y: p.oilC })),
      },
    ];
  });

  protected readonly deltaSeries = computed<ChartSeries[]>(() => {
    const compare = this.analysis.compare();
    if (!compare) {
      return [];
    }

    return [
      {
        label: `${refLabel(compare.lapB)} vs ${refLabel(compare.lapA, false)}`,
        colour: CHANNEL_COLOUR.delta,
        points: compare.points.map((point) => ({
          x: point.distM,
          y: point.deltaMs / 1000,
        })),
      },
    ];
  });

  /**
   * One channel from both laps, active first so it draws on top.
   *
   * The reference series is `muted`, which the chart renders dashed and
   * translucent — the same visual language as the ghost on the map, so the two
   * panels agree about which line is which without a second legend.
   */
  private channel(
    pick: (point: { speedKmh: number | null; rpm: number | null }) => number | null,
  ): ChartSeries[] {
    const series: ChartSeries[] = [
      {
        label: this.activeLabel(),
        colour: CHANNEL_COLOUR.active,
        points: this.activePoints().map((p) => ({ x: p.distM, y: pick(p) })),
      },
    ];

    const reference = this.referencePoints();
    if (reference.length) {
      series.push({
        label: this.referenceLabel(),
        // Still `muted`, so the active lap stays the readable one — the
        // optimal-red is a colour cue here, not the same solid full-weight
        // treatment the map gives it.
        colour:
          this.analysis.referenceLap() === 'optimal'
            ? CHANNEL_COLOUR.optimal
            : CHANNEL_COLOUR.reference,
        muted: true,
        points: reference.map((p) => ({ x: p.distM, y: pick(p) })),
      });
    }

    return series;
  }

  // ---------------------------------------------------------------------------
  // Commands
  // ---------------------------------------------------------------------------

  protected async recompute(): Promise<void> {
    this.recomputing.set(true);
    this.recomputeError.set(null);

    try {
      await this.analysis.recompute();
    } catch {
      // Deliberately not the thrown error: it can carry a server message, and
      // nothing on this path has anything useful to add beyond "it failed".
      this.recomputeError.set('Could not re-run the analysis.');
    } finally {
      this.recomputing.set(false);
    }
  }
}
