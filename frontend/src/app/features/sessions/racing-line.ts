import { Component, computed, input } from '@angular/core';
import { BrakingPoint, LapTracePoint } from '../../core/models/analysis.model';

/** Fraction of the track's own size left as padding around it. */
const MARGIN = 0.1;

/**
 * The racing line for one lap, with the reference lap ghosted underneath and
 * the braking points marked.
 *
 * **Still no tile basemap.** `track-trace.ts` deferred that choice to "the
 * Phase 4 analysis UI, which is where a real basemap actually earns its
 * weight" — and having arrived here, the answer is still not yet. A tile
 * provider is a dependency, an API key, and a privacy question (every tile
 * request tells a third party which circuit is being looked at, and these are
 * a named driver's traces). None of it is needed to see where two laps differ,
 * which is the entire job of this view.
 *
 * The line is coloured by speed rather than drawn flat: the shape alone cannot
 * show that two laps took the same corner at different speeds, and that is
 * usually the thing being looked for.
 */
@Component({
  selector: 'app-racing-line',
  template: `
    @if (geometry(); as g) {
      <svg
        [attr.viewBox]="g.viewBox"
        preserveAspectRatio="xMidYMid meet"
        role="img"
        aria-label="Racing line for the selected lap"
      >
        @if (g.ghost) {
          <path class="ghost" [attr.d]="g.ghost" />
        }

        @for (band of g.bands; track $index) {
          <path class="line" [attr.d]="band.d" [attr.stroke]="band.colour" />
        }

        @for (marker of g.braking; track marker.distM) {
          <circle
            class="brake"
            [attr.cx]="marker.x"
            [attr.cy]="marker.y"
            [attr.r]="g.dot"
          >
            <title>
              Braking at {{ marker.distM }} m — {{ marker.entrySpeedKmh }} km/h,
              {{ marker.peakDecelG }} g
            </title>
          </circle>
        }
      </svg>
    } @else {
      <p class="empty">No trace for this lap.</p>
    }
  `,
  styles: `
    :host {
      display: block;
      block-size: 100%;
    }
    svg {
      inline-size: 100%;
      block-size: 100%;
    }
    .line {
      fill: none;
      /* The viewBox is in degrees; non-scaling-stroke keeps this a real
         pixel width however far the lap is zoomed. */
      stroke-width: 3px;
      vector-effect: non-scaling-stroke;
      stroke-linecap: round;
      stroke-linejoin: round;
    }
    .ghost {
      fill: none;
      stroke: var(--muted);
      stroke-width: 2px;
      vector-effect: non-scaling-stroke;
      opacity: 0.5;
      stroke-dasharray: 6 5;
    }
    .brake {
      fill: #e8543f;
      stroke: var(--bg);
      stroke-width: 1px;
      vector-effect: non-scaling-stroke;
    }
    .empty {
      color: var(--muted);
      text-align: center;
    }
  `,
})
export class RacingLine {
  readonly points = input.required<LapTracePoint[]>();
  readonly ghostPoints = input<LapTracePoint[]>([]);
  readonly brakingPoints = input<BrakingPoint[]>([]);

  /**
   * Path, ghost, markers and viewBox in one computation.
   *
   * They share a projection and one set of bounds. Deriving them separately
   * would let the ghost and the markers be fitted to different frames than the
   * line — which reads as the car braking somewhere it did not.
   */
  protected readonly geometry = computed(() => {
    const points = this.points();
    if (points.length < 2) {
      return null;
    }

    // Equirectangular, scaled by cos(latitude): a degree of longitude is
    // shorter than a degree of latitude everywhere but the equator, and without
    // this a circuit comes out visibly stretched east-west.
    const scale = Math.cos((points[0].lat * Math.PI) / 180);
    const x = (point: { lon: number }) => point.lon * scale;
    // SVG's y grows downward; latitude grows north.
    const y = (point: { lat: number }) => -point.lat;

    const ghost = this.ghostPoints();
    let minX = Infinity;
    let maxX = -Infinity;
    let minY = Infinity;
    let maxY = -Infinity;

    // Bounds over both laps, so switching the comparison does not make the
    // frame jump.
    for (const point of [...points, ...ghost]) {
      minX = Math.min(minX, x(point));
      maxX = Math.max(maxX, x(point));
      minY = Math.min(minY, y(point));
      maxY = Math.max(maxY, y(point));
    }

    const width = maxX - minX;
    const height = maxY - minY;
    const pad = Math.max(width, height) * MARGIN;

    return {
      viewBox: `${minX - pad} ${minY - pad} ${width + pad * 2} ${height + pad * 2}`,
      bands: speedBands(points, x, y),
      ghost: ghost.length > 1 ? polyline(ghost, x, y) : null,
      braking: this.brakingPoints().map((marker) => ({
        ...marker,
        x: x(marker),
        y: y(marker),
      })),
      // Sized off the view, so a marker is the same visual size at any zoom.
      dot: Math.max(width, height) * 0.012,
    };
  });
}

/**
 * The speed palette: slow to fast.
 *
 * Five steps rather than a continuous gradient because SVG cannot stroke a path
 * with a gradient *along* it without a mask, and because five is as many as a
 * reader can tell apart at a glance on a 3 px line. Blue-to-red is the
 * convention every telemetry tool uses for this, so it needs no legend.
 */
const SPEED_COLOURS = ['#3f7fe8', '#4aa3df', '#5fc9a8', '#e8c14a', '#e8543f'];

/**
 * The lap split into runs of constant speed band, one path each.
 *
 * Runs rather than one path per segment: a 800-point lap is 799 segments, and
 * 799 `<path>` elements re-rendered on every lap change is a real cost for no
 * visible gain. Consecutive segments in the same band share a path, which on a
 * real circuit collapses it to a few dozen.
 *
 * Each run repeats its predecessor's last point, or the line would have a
 * one-segment hole at every band change.
 */
function speedBands(
  points: LapTracePoint[],
  x: (p: { lon: number }) => number,
  y: (p: { lat: number }) => number,
): { d: string; colour: string }[] {
  let min = Infinity;
  let max = -Infinity;
  for (const point of points) {
    if (point.speedKmh == null) {
      continue;
    }
    min = Math.min(min, point.speedKmh);
    max = Math.max(max, point.speedKmh);
  }

  // No speed channel at all — a replayed dash session record, for one. Draw the
  // shape in a single colour rather than nothing.
  if (!Number.isFinite(min) || max - min < 1e-9) {
    return [{ d: polyline(points, x, y), colour: SPEED_COLOURS[1] }];
  }

  const bandOf = (speed: number | null) =>
    speed == null
      ? 0
      : Math.min(
          SPEED_COLOURS.length - 1,
          Math.floor(((speed - min) / (max - min)) * SPEED_COLOURS.length),
        );

  const bands: { d: string; colour: string }[] = [];
  let current = -1;
  let d = '';

  for (const point of points) {
    const band = bandOf(point.speedKmh);

    if (band !== current) {
      if (d) {
        // Close the previous run *through* this point, then start here.
        bands.push({ d: `${d} L ${x(point)} ${y(point)}`, colour: SPEED_COLOURS[current] });
      }
      d = `M ${x(point)} ${y(point)}`;
      current = band;
      continue;
    }

    d += ` L ${x(point)} ${y(point)}`;
  }

  if (d && current >= 0) {
    bands.push({ d, colour: SPEED_COLOURS[current] });
  }

  return bands;
}

function polyline(
  points: LapTracePoint[],
  x: (p: { lon: number }) => number,
  y: (p: { lat: number }) => number,
): string {
  let d = '';
  for (const point of points) {
    d += `${d ? ' L' : 'M'} ${x(point)} ${y(point)}`;
  }
  return d;
}
