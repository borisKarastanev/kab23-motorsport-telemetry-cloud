import { Component, computed, input } from '@angular/core';
import { TracePoint } from '../../core/models/live-telemetry.model';

/** Fraction of the track's own size left as padding around it. */
const MARGIN = 0.08;

/** Below this the trace is a standing car, and the view must not zoom to noise. */
const MIN_SPAN_DEGREES = 0.0005;

/**
 * The car's recent path, drawn as plain inline SVG.
 *
 * **No tile provider and no map library, deliberately.** Phase 3 is about
 * latency and correctness; choosing MapLibre/Leaflet and a tile source belongs
 * with the Phase 4 analysis UI, which is where a real basemap actually earns
 * its weight. Fixing that choice here, on a view that exists to prove the live
 * path works, would settle it in the wrong place.
 */
@Component({
  selector: 'app-track-trace',
  template: `
    @if (geometry(); as g) {
      <svg
        class="trace"
        [attr.viewBox]="g.viewBox"
        preserveAspectRatio="xMidYMid meet"
        role="img"
        aria-label="Recent track position"
      >
        <path class="line" [attr.d]="g.path" />
        @if (g.marker; as m) {
          <circle class="car" [attr.cx]="m.x" [attr.cy]="m.y" [attr.r]="g.dot" />
        }
      </svg>
    } @else {
      <p class="empty">Waiting for a GPS fix…</p>
    }
  `,
  styles: `
    :host {
      display: block;
      block-size: 100%;
    }
    .trace {
      inline-size: 100%;
      block-size: 100%;
    }
    .line {
      fill: none;
      stroke: var(--accent);
      /* non-scaling-stroke keeps this 2 real pixels however far the viewBox
         zooms — the units here are degrees of longitude. */
      stroke-width: 2px;
      vector-effect: non-scaling-stroke;
      stroke-linecap: round;
      stroke-linejoin: round;
    }
    .car {
      fill: #e8543f;
    }
    .empty {
      color: var(--muted);
      text-align: center;
    }
  `,
})
export class TrackTrace {
  readonly points = input.required<TracePoint[]>();
  readonly position = input<TracePoint | null>(null);

  /**
   * Path, marker and viewBox in one computation.
   *
   * They share a projection and a set of bounds; deriving them separately would
   * let the marker drift out of the frame the path was fitted to.
   *
   * **One pass over the points, no intermediate arrays.** This re-runs on every
   * frame — 10 Hz, against a trace capped at 3 000 points — so projecting into
   * an array, mapping that to an array of xs and another of ys, and then
   * spreading each into `Math.min`/`Math.max` twice over would be eight full
   * scans and ~9 000 throwaway objects a frame. `Math.min(...xs)` on a 3 000
   * element array is also an argument list that large, which is a stack limit
   * waiting to be found by a longer trace.
   */
  readonly geometry = computed(() => {
    const points = this.points();
    if (!points.length) {
      return null;
    }

    // Equirectangular, scaled by cos(latitude): a degree of longitude is
    // shorter than a degree of latitude everywhere but the equator, and without
    // this correction a circuit comes out visibly stretched east-west.
    const scale = Math.cos((points[0].lat * Math.PI) / 180);
    const project = (point: TracePoint) => ({
      x: point.lon * scale,
      y: -point.lat, // SVG's y grows downward; latitude grows north.
    });

    let minX = Infinity;
    let maxX = -Infinity;
    let minY = Infinity;
    let maxY = -Infinity;
    let path = '';

    for (const point of points) {
      const x = point.lon * scale;
      const y = -point.lat;

      minX = Math.min(minX, x);
      maxX = Math.max(maxX, x);
      minY = Math.min(minY, y);
      maxY = Math.max(maxY, y);

      path += `${path ? ' L' : 'M'} ${x} ${y}`;
    }

    // A stationary car produces a degenerate box; clamping the span stops the
    // view zooming into GPS jitter and swinging around.
    const width = Math.max(maxX - minX, MIN_SPAN_DEGREES);
    const height = Math.max(maxY - minY, MIN_SPAN_DEGREES);
    const pad = Math.max(width, height) * MARGIN;

    // Centred on the points rather than anchored at their minimum, so a clamped
    // span grows in both directions instead of pushing the trace to one edge.
    const originX = (minX + maxX) / 2 - width / 2 - pad;
    const originY = (minY + maxY) / 2 - height / 2 - pad;

    const current = this.position();

    return {
      viewBox: `${originX} ${originY} ${width + pad * 2} ${height + pad * 2}`,
      path,
      marker: current ? project(current) : null,
      // Sized off the view, so the dot stays the same visual size at any zoom.
      dot: Math.max(width, height) * 0.02,
    };
  });
}
