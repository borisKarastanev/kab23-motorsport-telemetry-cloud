import { Component, computed, input } from '@angular/core';

export interface ChartSeries {
  label: string;
  /** CSS colour. */
  colour: string;
  /** x is distance in metres; y is the channel. Nulls break the line. */
  points: { x: number; y: number | null }[];
  /** Draw beneath the others, thinner — the ghost lap. */
  muted?: boolean;
}

/** Drawing box in viewBox units. The SVG scales; these are just proportions. */
const WIDTH = 1000;
const HEIGHT = 260;
const PAD = { top: 12, right: 12, bottom: 26, left: 46 };
const PLOT_W = WIDTH - PAD.left - PAD.right;
const PLOT_H = HEIGHT - PAD.top - PAD.bottom;

/**
 * A distance-indexed line chart, in plain inline SVG.
 *
 * **No charting library, deliberately** — the same call `track-trace.ts` made
 * for the live map, and for a stronger reason here: every chart in this view is
 * one or two polylines against a shared x axis with a handful of gridlines. A
 * charting dependency would bring a bundle, a theming system and an API to
 * learn, to draw a `<path>`.
 *
 * The x axis is **distance, not time**. Two laps of the same circuit have the
 * same length and different durations, so a time axis puts the same corner in a
 * different place on every lap and makes an overlay meaningless. This is the
 * same reason the API returns distance-indexed traces.
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

      <svg
        [attr.viewBox]="'0 0 ' + width + ' ' + height"
        preserveAspectRatio="none"
        role="img"
        [attr.aria-label]="title() + ' against distance around the lap'"
      >
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
            <text class="label mid" [attr.x]="tick.x" [attr.y]="height - 8">
              {{ tick.label }}
            </text>
          }

          @for (line of g.lines; track line.label) {
            <path
              class="series"
              [class.muted]="line.muted"
              [attr.d]="line.d"
              [attr.stroke]="line.colour"
            />
          }
        } @else {
          <text class="label mid empty" [attr.x]="width / 2" [attr.y]="height / 2">
            No data
          </text>
        }
      </svg>
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
    svg {
      inline-size: 100%;
      block-size: 9rem;
      display: block;
    }
    .grid {
      stroke: var(--border);
      stroke-width: 1;
      vector-effect: non-scaling-stroke;
    }
    .grid.zero {
      stroke: var(--muted);
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
      /* The viewBox is stretched to the element, so a scaled stroke would be
         thicker vertically than horizontally. */
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
  readonly title = input.required<string>();
  readonly series = input.required<ChartSeries[]>();
  readonly unit = input('');
  /**
   * Keep zero on the axis even when the data does not reach it.
   *
   * On by default because a speed trace between 70 and 185 km/h drawn on a
   * 70-based axis exaggerates every wiggle into a cliff. The delta chart turns
   * it off: there, zero is guaranteed to be in range and the whole point is to
   * see small differences.
   */
  readonly includeZero = input(true);

  protected readonly width = WIDTH;
  protected readonly height = HEIGHT;
  protected readonly pad = PAD;

  protected readonly geometry = computed(() => {
    const series = this.series().filter((one) => one.points.length > 0);
    if (!series.length) {
      return null;
    }

    let maxX = 0;
    let minY = Infinity;
    let maxY = -Infinity;

    for (const one of series) {
      for (const point of one.points) {
        maxX = Math.max(maxX, point.x);
        if (point.y == null) {
          continue;
        }
        minY = Math.min(minY, point.y);
        maxY = Math.max(maxY, point.y);
      }
    }

    if (!Number.isFinite(minY) || maxX <= 0) {
      return null;
    }

    if (this.includeZero()) {
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
    const lowY = minY - padY;
    const highY = maxY + padY;

    const toX = (x: number) => PAD.left + (x / maxX) * PLOT_W;
    const toY = (y: number) =>
      PAD.top + PLOT_H - ((y - lowY) / (highY - lowY)) * PLOT_H;

    return {
      lines: series.map((one) => ({
        label: one.label,
        colour: one.colour,
        muted: one.muted ?? false,
        d: pathFor(one.points, toX, toY),
      })),
      yTicks: ticks(lowY, highY, 4).map((value) => ({
        value,
        y: toY(value),
        zero: Math.abs(value) < 1e-9,
        label: format(value) + this.unit(),
      })),
      xTicks: ticks(0, maxX, 4).map((value) => ({
        value,
        x: toX(value),
        label: `${Math.round(value)} m`,
      })),
    };
  });
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
  return Array.from(
    { length: count + 1 },
    (_, i) => low + ((high - low) * i) / count,
  );
}

const format = (value: number): string =>
  Math.abs(value) >= 100 ? value.toFixed(0) : value.toFixed(1);
