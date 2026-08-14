import { Component, computed, input, linkedSignal, signal } from '@angular/core';
import { wheelZoomFactor } from '../canvas/canvas-viewport';

export interface ChartSeries {
  label: string;
  /** CSS colour. */
  colour: string;
  /** x is the chart's index — distance in the analysis view, elapsed seconds live. y is the channel. Nulls break the line. */
  points: { x: number; y: number | null }[];
  /** Draw beneath the others, thinner — the ghost lap. */
  muted?: boolean;
}

/**
 * One colour per channel, for every chart in the app.
 *
 * Lives beside the chart rather than in each feature: the analysis view and
 * the live view draw the same channels, and a coolant trace that is red on
 * one page and orange on the other reads as two different measurements. These
 * were previously spelled as hex literals in both components, with nothing
 * tying them together.
 */
export const CHANNEL_COLOUR = {
  /** The lap or car being looked at. */
  active: '#4aa3df',
  /** The ghost lap it is compared against. */
  reference: '#8b93a1',
  coolant: '#e8543f',
  oil: '#e8c14a',
} as const;

/**
 * Drawing box in viewBox units.
 *
 * `left` is wide enough for the longest tick label this chart draws — "120
 * km/h" — plus its unit. Too narrow and the label doesn't just crowd the
 * plot, it renders past x=0 and is clipped by the viewBox entirely.
 */
const WIDTH = 1000;
const HEIGHT = 160;
const PAD = { top: 8, right: 12, bottom: 8, left: 88 };
const PLOT_W = WIDTH - PAD.left - PAD.right;

/** Extra bottom padding when the x axis is labelled — see `padBottom`. */
const X_LABEL_BAND = 14;

/** How far past the fitted (fully zoomed-out) view a user may zoom in. */
const MAX_ZOOM = 8;

/**
 * How many x buckets the visible window is reduced to before a path is built.
 *
 * The plot is `PLOT_W` (900) viewBox units wide and the rendered element is
 * usually narrower than that in CSS pixels, so anything beyond roughly one
 * point per unit is invisible. The live view pushes 3 000-point buffers
 * through four series at 10 Hz; without this, every frame rebuilt four
 * ~60 KB `d` strings — 24 000 `toFixed` calls and a quarter of a megabyte of
 * string garbage per second — for a picture identical to the decimated one.
 * Keeping each bucket's min and max (plus its endpoints, so buckets join up)
 * stops spikes being averaged away, which is the usual failure of naive "take
 * every nth point".
 */
const DISPLAY_BUCKETS = PLOT_W / 2;

interface ZoomState {
  scale: number;
  /** Left edge of the visible window, in data-x units. */
  offset: number;
}

/** Keeps the visible window inside `[0, domainSpan]` as scale/domain change. */
function clampOffset(offset: number, domainSpan: number, visibleSpan: number): number {
  return Math.min(Math.max(offset, 0), Math.max(0, domainSpan - visibleSpan));
}

/** Where in the plot area the pointer is, 0 at its left edge and 1 at its right. */
function plotFraction(event: WheelEvent): number {
  const rect = (event.currentTarget as SVGSVGElement).getBoundingClientRect();
  const cursorX = ((event.clientX - rect.left) / rect.width) * WIDTH;
  return (cursorX - PAD.left) / PLOT_W;
}

/**
 * A generic x/y line chart, in plain inline SVG.
 *
 * **No charting library, deliberately** — the same call `track-trace.ts` made
 * for the live map: every chart built from this is one or two polylines
 * against a shared x axis with a handful of gridlines. A charting dependency
 * would bring a bundle, a theming system and an API to learn, to draw a
 * `<path>`.
 *
 * Shared between the analysis view, where the x axis is **distance**, and the
 * live view, where it is **elapsed seconds** — two laps of the same circuit
 * have the same length and different durations, so a time axis there would put
 * the same corner in a different place on every lap and make an overlay
 * meaningless, while a live stream has no lap to index by until one closes.
 *
 * **`showXAxis` is opt-in.** Distance is worth labelling: "where on the lap
 * is this dip" is the question the analysis view exists to answer, and with
 * zoom available an unlabelled axis cannot answer it. Elapsed seconds on the
 * live view are not — the reading that matters there is the one at the
 * right-hand edge, which is now, and a running clock along the bottom is just
 * noise. So the live view leaves it off and the bottom padding collapses with
 * the labels.
 *
 * **Zoomable and pannable on x only** — ctrl/⌘+wheel or drag, "Reset zoom" to
 * return to the fitted view, the same interaction the map views use (see
 * `track-trace.ts`). The y axis is deliberately exempt: it is computed from
 * the *entire* series regardless of the visible x window, so the scale on
 * the left never jumps around while zooming — only the horizontal window
 * changes. A `<clipPath>` keeps zoomed-in lines from bleeding into the
 * y-axis label gutter.
 */
@Component({
  selector: 'app-line-chart',
  template: `
    <figure>
      <figcaption>
        <span class="title">{{ title() }}</span>
        <span class="legend">
          @for (series of series(); track series.label) {
            <span class="key">
              <span class="swatch" [style.background]="series.colour"></span>
              {{ series.label }}
            </span>
          }
        </span>
      </figcaption>

      <div class="stage">
        <svg
          [attr.viewBox]="'0 0 ' + width + ' ' + height"
          [style.aspect-ratio]="width + ' / ' + height"
          [class.dragging]="dragPointer() !== null"
          role="img"
          [attr.aria-label]="title() + ' chart. Ctrl and scroll to zoom, drag to pan.'"
          (wheel)="onWheel($event)"
          (pointerdown)="onPointerDown($event)"
          (pointermove)="onPointerMove($event)"
          (pointerup)="onPointerUp($event)"
          (pointercancel)="onPointerUp($event)"
        >
          <defs>
            <clipPath [attr.id]="clipId">
              <rect
                [attr.x]="pad.left"
                [attr.y]="pad.top"
                [attr.width]="width - pad.left - pad.right"
                [attr.height]="height - pad.top - padBottom()"
              />
            </clipPath>
          </defs>

          @if (geometry(); as g) {
            @for (tick of g.yTicks; track tick.value) {
              <line
                class="grid"
                [attr.x1]="pad.left"
                [attr.x2]="width - pad.right"
                [attr.y1]="tick.y"
                [attr.y2]="tick.y"
                [class.zero]="tick.zero"
              />
              <text class="label" [attr.x]="pad.left - 6" [attr.y]="tick.y + 4">
                {{ tick.label }}
              </text>
            }

            @for (tick of g.xTicks; track tick.value) {
              <text class="label mid" [attr.x]="tick.x" [attr.y]="height - 3">
                {{ tick.label }}
              </text>
            }

            <g [attr.clip-path]="'url(#' + clipId + ')'">
              @for (line of g.lines; track line.label) {
                <path
                  class="series"
                  [class.muted]="line.muted"
                  [attr.d]="line.d"
                  [attr.stroke]="line.colour"
                />
              }
            </g>
          } @else {
            <text class="label mid empty" [attr.x]="width / 2" [attr.y]="height / 2">No data</text>
          }
        </svg>

        @if (geometry(); as g) {
          <div class="controls">
            <!-- The maps zoom on a plain wheel; these need ctrl/⌘ (see
                 onWheel), and nothing on screen said so — which reads as a
                 chart that will not zoom. Shown only until it has been used. -->
            @if (g.visibleSpan >= domainSpan()) {
              <span class="hint">Ctrl + scroll to zoom</span>
            }
            <button type="button" class="reset" (click)="resetZoom()">Reset zoom</button>
          </div>
        }
      </div>
    </figure>
  `,
  styles: `
    :host {
      display: block;
    }
    figure {
      margin: 0;
    }
    figcaption {
      display: flex;
      flex-wrap: wrap;
      align-items: baseline;
      gap: 0.75rem;
      margin-block-end: 0.35rem;
    }
    .title {
      font-size: 0.75rem;
      text-transform: uppercase;
      letter-spacing: 0.08em;
      color: var(--muted);
    }
    .legend {
      display: flex;
      gap: 0.75rem;
      font-size: 0.75rem;
      color: var(--muted);
    }
    .key {
      display: flex;
      align-items: center;
      gap: 0.3rem;
    }
    .swatch {
      inline-size: 0.7rem;
      block-size: 0.2rem;
      border-radius: 1rem;
    }
    .stage {
      position: relative;
    }
    svg {
      /* aspect-ratio is set inline from width/height above, not here — it
         has to be the same numbers as the viewBox or the browser scales x
         and y by different factors. A fixed block-size at 100% inline-size
         let the two drift apart, stretching every tick label (and the
         plotted lines) horizontally on a wide panel. */
      inline-size: 100%;
      display: block;
      /* pan-y, not none: the browser keeps vertical scrolling — on the
         live view these charts cover most of the page, and 'none' made it
         impossible to scroll past them on a tablet — while horizontal drags
         are left to the pointer handlers below, which pan the chart. */
      touch-action: pan-y;
      cursor: grab;

      &.dragging {
        cursor: grabbing;
      }
    }
    .controls {
      position: absolute;
      inset-block-start: 0.4rem;
      inset-inline-end: 0.4rem;
      display: flex;
      align-items: center;
      gap: 0.5rem;
    }
    .hint {
      font-size: 0.7rem;
      color: var(--muted);
      /* Advisory only — it must never eat a drag aimed at the plot. */
      pointer-events: none;
    }
    .reset {
      font: inherit;
      font-size: 0.7rem;
      padding: 0.2rem 0.6rem;
      border: 1px solid var(--border);
      border-radius: 0.4rem;
      background: var(--surface);
      color: var(--text);
      cursor: pointer;

      &:hover {
        border-color: var(--accent);
      }
    }
    .grid {
      stroke: var(--muted);
      stroke-width: 1;
      vector-effect: non-scaling-stroke;
      opacity: 0.3;
    }
    .grid.zero {
      opacity: 0.7;
    }
    .label {
      fill: var(--muted);
      font-size: 13px;
      text-anchor: end;
    }
    .label.mid {
      text-anchor: middle;
    }
    .empty {
      font-size: 16px;
    }
    .series {
      fill: none;
      stroke-width: 2px;
      /* Keeps the stroke a constant on-screen width regardless of the
         viewBox-to-element scale factor. */
      vector-effect: non-scaling-stroke;
      stroke-linejoin: round;
      stroke-linecap: round;
    }
    .series.muted {
      stroke-width: 1.5px;
      opacity: 0.55;
      stroke-dasharray: 5 4;
    }
  `,
})
export class LineChart {
  private static nextId = 0;

  readonly title = input.required<string>();
  readonly series = input.required<ChartSeries[]>();
  readonly unit = input('');
  /**
   * The channel can go negative, so let the axis float.
   *
   * Off by default, which does two things for a channel that physically
   * cannot go below zero (speed, RPM, coolant/oil temperature): it keeps zero
   * on the axis even when the data does not reach it — a speed trace between
   * 70 and 185 km/h drawn on a 70-based axis exaggerates every wiggle into a
   * cliff — and it stops the 8% padding below the lowest reading dipping the
   * axis under zero. The delta chart is the one caller that turns it on:
   * there, zero is guaranteed to be in range and the whole point is to see
   * small differences either side of it.
   */
  readonly signed = input(false);
  /**
   * Label the x axis. Off by default; see the class docblock for why the live
   * view wants that. Adds `X_LABEL_BAND` of bottom padding when on.
   */
  readonly showXAxis = input(false);
  /** Suffix for the x-axis tick labels — `' m'` on the analysis view. Only read when `showXAxis`. */
  readonly xUnit = input('');
  /** Changing this resets zoom/pan to the fitted view — bind the session or car id, not the lap number. */
  readonly resetKey = input<unknown>(undefined);

  protected readonly width = WIDTH;
  protected readonly height = HEIGHT;
  protected readonly pad = PAD;
  protected readonly clipId = `line-chart-clip-${LineChart.nextId++}`;

  /** The full x extent, for the template's "still fully zoomed out" check. */
  protected readonly domainSpan = computed(() => this.domain()?.domainSpan ?? 0);

  /** Room for the x tick labels, only when there are any. */
  protected readonly padBottom = computed(() =>
    this.showXAxis() ? PAD.bottom + X_LABEL_BAND : PAD.bottom,
  );

  /** The pointer currently panning, or `null` — also what drives the grab cursor. */
  protected readonly dragPointer = signal<number | null>(null);
  private dragLastClientX = 0;

  /**
   * The visible window, as a scale and an offset *from `domainMin`*.
   *
   * Relative to the domain's start rather than absolute, so the fitted state
   * stays a plain `{ scale: 1, offset: 0 }` even on the live view, whose
   * domain starts wherever the rolling buffer currently begins. Resets
   * whenever `resetKey` changes, same pattern as the map views'
   * `userTransform` in `viewport-controller.ts`.
   */
  private readonly zoom = linkedSignal<unknown, ZoomState>({
    source: () => this.resetKey(),
    computation: () => ({ scale: 1, offset: 0 }),
  });

  /**
   * Everything zoom and pan cannot change: the x domain and the y scale.
   *
   * Split out from `geometry` because it is the only O(points) pass in the
   * component and it does *not* depend on `zoom()` — the y axis is computed
   * from the entire series by design (see the class docblock). Folded
   * together, every pointermove during a drag re-scanned every point of every
   * series to arrive at the same answer.
   */
  private readonly domain = computed(() => {
    const series = this.series().filter((one) => one.points.length > 0);
    if (!series.length) {
      return null;
    }

    let domainMin = Infinity;
    let domainMax = -Infinity;
    let minY = Infinity;
    let maxY = -Infinity;

    for (const one of series) {
      for (const point of one.points) {
        domainMin = Math.min(domainMin, point.x);
        domainMax = Math.max(domainMax, point.x);
        if (point.y == null) {
          continue;
        }
        minY = Math.min(minY, point.y);
        maxY = Math.max(maxY, point.y);
      }
    }

    // The domain is `[domainMin, domainMax]`, not `[0, domainMax]`: the live
    // view's x is elapsed seconds and its buffer rolls, so once it has
    // trimmed anything its oldest point is no longer at zero. Assuming zero
    // there left the chart's left edge empty and squeezed the trace into a
    // shrinking sliver on the right — and made every caller re-zero its own x
    // before handing the points over.
    const domainSpan = domainMax - domainMin;
    if (!Number.isFinite(minY) || !(domainSpan > 0)) {
      return null;
    }

    if (!this.signed()) {
      minY = Math.min(minY, 0);
      maxY = Math.max(maxY, 0);
    }

    // A flat channel — a coolant temperature that never moves — would otherwise
    // divide by zero and draw at the top of the box.
    if (maxY - minY < 1e-9) {
      minY -= 1;
      maxY += 1;
    }

    const padY = (maxY - minY) * 0.08;
    let lowY = minY - padY;
    const highY = maxY + padY;

    if (!this.signed()) {
      lowY = Math.max(0, lowY);
    }

    return { series, domainMin, domainSpan, lowY, highY };
  });

  protected readonly geometry = computed(() => {
    const d = this.domain();
    if (!d) {
      return null;
    }

    const { visibleSpan, left } = this.window(d);

    const plotH = HEIGHT - PAD.top - this.padBottom();
    const toX = (x: number) => PAD.left + ((x - left) / visibleSpan) * PLOT_W;
    const toY = (y: number) => PAD.top + plotH - ((y - d.lowY) / (d.highY - d.lowY)) * plotH;

    return {
      // The window actually drawn — the x extent every path below was built
      // against, and what a zoom gesture changes.
      left,
      visibleSpan,
      lines: d.series.map((one) => ({
        label: one.label,
        colour: one.colour,
        muted: one.muted ?? false,
        d: pathFor(forDisplay(one.points, left, left + visibleSpan), toX, toY),
      })),
      yTicks: ticks(d.lowY, d.highY, 4).map((value) => ({
        value,
        y: toY(value),
        zero: Math.abs(value) < 1e-9,
        label: format(value) + this.unit(),
      })),
      // Across the *visible* window, not the whole domain: zoomed in, labels
      // spanning the full lap would point at the wrong part of the trace.
      xTicks: this.showXAxis()
        ? ticks(left, left + visibleSpan, 4).map((value) => ({
            value,
            x: toX(value),
            label: `${Math.round(value)}${this.xUnit()}`,
          }))
        : [],
    };
  });

  /**
   * The visible window for a domain, with the stored zoom state clamped into
   * it. Clamping happens on *read* rather than on write because the domain
   * grows under a live chart: an offset that was at the right-hand edge when
   * the gesture ended is mid-domain a second later.
   */
  private window(d: { domainMin: number; domainSpan: number }): {
    scale: number;
    visibleSpan: number;
    offset: number;
    left: number;
  } {
    const scale = Math.max(1, this.zoom().scale);
    const visibleSpan = d.domainSpan / scale;
    const offset = clampOffset(this.zoom().offset, d.domainSpan, visibleSpan);

    return { scale, visibleSpan, offset, left: d.domainMin + offset };
  }

  protected onWheel(event: WheelEvent): void {
    // Ctrl/⌘ required, and nothing is prevented without it. The live view
    // stacks three of these plus the map, so most of the page's height is
    // chart: swallowing a plain wheel would leave a manager scrolling down
    // the page and silently zooming a chart instead. Ctrl+wheel is also what
    // a trackpad pinch sends, so pinch-to-zoom on the chart still works.
    if (!event.ctrlKey && !event.metaKey) {
      return;
    }

    // `domain()`, not `geometry()`: the gesture only needs the x extent, and
    // reading the cheap half keeps a drag from re-scanning every point.
    const d = this.domain();
    if (!d) {
      return;
    }
    event.preventDefault();

    const { scale, visibleSpan, offset } = this.window(d);
    const fraction = plotFraction(event);
    const cursorData = offset + fraction * visibleSpan;

    const factor = wheelZoomFactor(event);
    const newScale = Math.min(MAX_ZOOM, Math.max(1, scale * factor));
    if (newScale === scale) {
      return;
    }

    // Keeps the data point under the cursor where it is, rather than zooming
    // toward the middle of the window.
    const newSpan = d.domainSpan / newScale;
    this.zoom.set({ scale: newScale, offset: cursorData - fraction * newSpan });
  }

  protected onPointerDown(event: PointerEvent): void {
    (event.currentTarget as SVGSVGElement).setPointerCapture(event.pointerId);
    this.dragPointer.set(event.pointerId);
    this.dragLastClientX = event.clientX;
  }

  protected onPointerMove(event: PointerEvent): void {
    if (event.pointerId !== this.dragPointer()) {
      return;
    }

    const d = this.domain();
    if (!d) {
      return;
    }

    const { scale, visibleSpan, offset } = this.window(d);
    const rect = (event.currentTarget as SVGSVGElement).getBoundingClientRect();
    const dxUnits = ((event.clientX - this.dragLastClientX) / rect.width) * WIDTH;
    this.dragLastClientX = event.clientX;

    // Stored unclamped; `window` clamps on read, which is the one place that
    // can account for a domain that has grown since the gesture.
    const dxData = (dxUnits / PLOT_W) * visibleSpan;
    this.zoom.set({ scale, offset: offset - dxData });
  }

  protected onPointerUp(event: PointerEvent): void {
    if (event.pointerId !== this.dragPointer()) {
      return;
    }
    this.dragPointer.set(null);
  }

  protected resetZoom(): void {
    this.zoom.set({ scale: 1, offset: 0 });
  }
}

/**
 * The points worth drawing for the current window: clipped to it, then
 * reduced to at most four per x bucket — its endpoints and its min/max.
 *
 * Both halves matter, and for different reasons. Clipping is what makes
 * zooming cheap — at 8× the old code still stringified all 3 000 points to
 * draw the 375 that were on screen. Bucketing is what makes the unzoomed
 * live view cheap — see `DISPLAY_BUCKETS`.
 *
 * Keeping the min *and* the max of each bucket is what stops decimation from
 * eating a braking spike: the envelope survives even where 30 samples
 * collapse into one bucket. They are emitted in sample order so the line
 * still runs left to right, and the first and last sample of each bucket are
 * kept too so bucket boundaries join up.
 *
 * Assumes x is ascending, which holds for every caller: distance around a
 * lap and elapsed time both only increase.
 */
function forDisplay(
  points: { x: number; y: number | null }[],
  xMin: number,
  xMax: number,
): { x: number; y: number | null }[] {
  if (points.length === 0) {
    return points;
  }

  // One sample either side of the window, so the segments crossing the clip
  // edge are still drawn rather than the line stopping short of it.
  let lo = 0;
  while (lo < points.length - 1 && points[lo + 1].x < xMin) {
    lo++;
  }
  let hi = points.length - 1;
  while (hi > lo && points[hi - 1].x > xMax) {
    hi--;
  }

  const bucketWidth = (xMax - xMin) / DISPLAY_BUCKETS;
  if (!(bucketWidth > 0)) {
    return points.slice(lo, hi + 1);
  }

  const out: { x: number; y: number | null }[] = [];
  let bucket = NaN;
  // Indices into `points` for the current bucket; `-1` means "not set".
  let first = -1;
  let last = -1;
  let lowest = -1;
  let highest = -1;
  /** Last index emitted, so a repeat is dropped rather than drawn twice. */
  let previous = -1;

  const emit = (i: number) => {
    if (i !== previous) {
      out.push(points[i]);
      previous = i;
    }
  };

  const flush = () => {
    if (first < 0) {
      return;
    }
    // Already in sample order, so no sorting: all four are set from the same
    // ascending scan, which makes `first <= min(lowest, highest) <=
    // max(lowest, highest) <= last` hold by construction. Only the min/max
    // pair can be either way round, and only repeats need dropping —
    // `lowest`/`highest` are often the endpoints themselves.
    emit(first);
    emit(Math.min(lowest, highest));
    emit(Math.max(lowest, highest));
    emit(last);
    first = last = lowest = highest = -1;
  };

  for (let i = lo; i <= hi; i++) {
    const point = points[i];

    // A gap is a hard break: flush what is buffered, then emit the null so
    // `pathFor` lifts the pen. Bucketing across it would bridge the dropout.
    if (point.y == null) {
      flush();
      bucket = NaN;
      out.push(point);
      continue;
    }

    const index = Math.floor((point.x - xMin) / bucketWidth);
    if (index !== bucket) {
      flush();
      bucket = index;
    }

    if (first < 0) {
      first = i;
    }
    last = i;
    if (lowest < 0 || point.y < (points[lowest].y as number)) {
      lowest = i;
    }
    if (highest < 0 || point.y > (points[highest].y as number)) {
      highest = i;
    }
  }

  flush();
  return out;
}

/**
 * One path, breaking wherever the channel is null.
 *
 * A gap is drawn as a gap rather than bridged: a dropout is not a straight line
 * between the readings either side of it, and drawing one invents data.
 */
function pathFor(
  points: { x: number; y: number | null }[],
  toX: (x: number) => number,
  toY: (y: number) => number,
): string {
  let d = '';
  let open = false;

  for (const point of points) {
    if (point.y == null) {
      open = false;
      continue;
    }

    d += `${open ? ' L' : ' M'} ${toX(point.x).toFixed(1)} ${toY(point.y).toFixed(1)}`;
    open = true;
  }

  return d.trim();
}

/** `count` evenly spaced values across the range, endpoints included. */
function ticks(low: number, high: number, count: number): number[] {
  return Array.from({ length: count + 1 }, (_, i) => low + ((high - low) * i) / count);
}

const format = (value: number): string =>
  Math.abs(value) >= 100 ? value.toFixed(0) : value.toFixed(1);
