import {
  Component,
  ElementRef,
  afterNextRender,
  afterRenderEffect,
  computed,
  input,
  viewChild,
} from '@angular/core';
import { TracePoint } from '../../core/models/live-telemetry.model';
import { TrackMapGeoJson, isCircuit } from '../../core/models/track-map.model';
import {
  Bounds,
  ViewTransform,
  WorldPoint,
  sizeCanvasForDisplay,
  strokePolyline,
} from '../../core/canvas/canvas-viewport';
import { createCanvasViewport } from '../../core/canvas/viewport-controller';

/** Fraction of the track's own size left as padding around it, at the fitted (unzoomed) view. */
const MARGIN = 0.08;

/** Below this the trace is a standing car, and the fitted view must not zoom to GPS jitter. */
const MIN_SPAN_DEGREES = 0.0005;

/** How far past the fitted view a user can zoom in. Fitted view itself is the zoom-out limit. */
const MAX_ZOOM_MULTIPLIER = 40;

/** Metres per degree of latitude — good enough for a visual overlay's scale, not survey work. */
const METERS_PER_DEG_LAT = 111000;

/** Constant on-screen pixel sizes, independent of zoom — divided by `transform.scale` at draw
 * time, the canvas equivalent of SVG's `vector-effect: non-scaling-stroke`. */
const LINE_WIDTH_PX = 2;
const CAR_RADIUS_PX = 6;

interface WorldGeometry {
  bounds: Bounds;
  /** Fitting is clamped against GPS jitter only when there is no circuit to fit to instead. */
  minSpan: number | undefined;
  trace: WorldPoint[];
  marker: WorldPoint | null;
  circuit: { points: WorldPoint[]; widthM: number } | null;
}

/**
 * The car's recent path — with the circuit itself underneath it, when
 * `TrackMapService` has one for this car's session. Zoomable and pannable:
 * wheel or pinch to zoom, drag to pan, "Reset view" to fit again.
 *
 * **Canvas, not SVG.** `racing-line.ts` carries the fuller rationale — the
 * same real limit applied here: `viewBox` auto-fits but has no interactive
 * zoom, so a pit wall watching a car live had no way to get closer than "the
 * whole circuit" to see it through one corner in detail.
 *
 * **The view fits the circuit, not the moving trace, once one is known.**
 * Without a map the frame has always chased the last `MAX_LIVE_POINTS` of
 * GPS — reasonable when there is nothing else to anchor to. With a map, doing
 * that would make the *track* appear to slide under a car that is, in truth,
 * the only thing moving; fitting the circuit's own extent instead holds the
 * layout still and lets the marker move across it, the way a pit wall reads
 * a track map.
 *
 * **A user zoom/pan suspends auto-fit entirely**, in both modes — falls out
 * of `transform` below rather than needing a special case: auto-fit only
 * runs while `userTransform` is `null`, and any wheel, drag or pinch sets it.
 */
@Component({
  selector: 'app-track-trace',
  template: `
    <div class="stage" #container>
      <canvas
        #canvas
        class="canvas"
        [class.dragging]="viewport.isDragging()"
        role="img"
        aria-label="Recent track position. Scroll or pinch to zoom, drag to pan."
        (wheel)="viewport.onWheel($event)"
        (pointerdown)="viewport.onPointerDown($event)"
        (pointermove)="viewport.onPointerMove($event)"
        (pointerup)="viewport.onPointerUp($event)"
        (pointercancel)="viewport.onPointerUp($event)"
      ></canvas>

      @if (!world()) {
        <p class="empty">Waiting for a GPS fix…</p>
      } @else {
        <button type="button" class="reset" (click)="viewport.resetView()">Reset view</button>
      }
    </div>
  `,
  styles: `
    :host {
      display: block;
      block-size: 100%;
    }
    .stage {
      position: relative;
      inline-size: 100%;
      block-size: 100%;
    }
    .canvas {
      position: absolute;
      inset: 0;
      inline-size: 100%;
      block-size: 100%;
      touch-action: none;
      cursor: grab;

      &.dragging {
        cursor: grabbing;
      }
    }
    .reset {
      position: absolute;
      inset-block-start: 0.5rem;
      inset-inline-end: 0.5rem;
      font: inherit;
      font-size: 0.7rem;
      padding: 0.25rem 0.6rem;
      border: 1px solid var(--border);
      border-radius: 0.4rem;
      background: var(--surface);
      color: var(--text);
      cursor: pointer;

      &:hover {
        border-color: var(--accent);
      }
    }
    .empty {
      position: absolute;
      inset: 0;
      display: grid;
      place-items: center;
      color: var(--muted);
      text-align: center;
    }
  `,
})
export class TrackTrace {
  readonly points = input.required<TracePoint[]>();
  readonly position = input<TracePoint | null>(null);
  readonly trackMap = input<TrackMapGeoJson | null>(null);
  /** Changing this resets zoom/pan to fit — bind the car id, not the session id. */
  readonly resetKey = input<unknown>(undefined);

  private readonly containerRef = viewChild.required<ElementRef<HTMLDivElement>>('container');
  private readonly canvasRef = viewChild.required<ElementRef<HTMLCanvasElement>>('canvas');

  /**
   * Pan/pinch/wheel zoom and the fitted view, shared with the analysis view's
   * racing line — see `createCanvasViewport`.
   */
  protected readonly viewport = createCanvasViewport({
    fitTo: () => this.world(),
    canvas: () => this.canvasRef()?.nativeElement,
    margin: MARGIN,
    maxZoomMultiplier: MAX_ZOOM_MULTIPLIER,
    resetKey: () => this.resetKey(),
  });

  /**
   * The circuit, projected once per track rather than once per frame.
   *
   * Split out of `world` deliberately. `world` invalidates at 10 Hz, because
   * `LiveTelemetryService` publishes a new `points` array on every frame — but
   * none of this depends on that: the feature lookup, the projection of every
   * ring coordinate and the bounds pass over them all depend only on
   * `trackMap()`, which changes once per session. Folded into `world` they were
   * redone ten times a second for the lifetime of a pit-wall tab, producing a
   * byte-identical result each time.
   *
   * Keeping `bounds` a stable reference here is the second half of the win: it
   * stops `transform` and `zoomLimits` re-fitting per frame too.
   */
  private readonly circuitWorld = computed(() => {
    const circuit = this.trackMap()?.features.find(isCircuit) ?? null;
    if (!circuit) {
      return null;
    }

    // Anchored on the circuit's own first point, so the projection is stable
    // even before the first GPS fix arrives.
    const scale = Math.cos((circuit.geometry.coordinates[0][1] * Math.PI) / 180);
    const points = circuit.geometry.coordinates.map(([lon, lat]) => ({
      x: lon * scale,
      y: -lat,
    }));

    let minX = Infinity;
    let maxX = -Infinity;
    let minY = Infinity;
    let maxY = -Infinity;
    for (const p of points) {
      minX = Math.min(minX, p.x);
      maxX = Math.max(maxX, p.x);
      minY = Math.min(minY, p.y);
      maxY = Math.max(maxY, p.y);
    }

    return {
      scale,
      points,
      widthM: circuit.properties.widthM,
      bounds: { minX, maxX, minY, maxY },
    };
  });

  /**
   * World-space geometry: projected trace, marker, circuit and the bounds to
   * fit when there is no user override. One pass over `points`, no
   * intermediate arrays beyond the projected trace itself — this recomputes
   * at 10 Hz against a trace capped at 3 000 points, so an extra full scan or
   * two here is a real per-frame cost, not a one-off.
   */
  protected readonly world = computed<WorldGeometry | null>(() => {
    const points = this.points();
    const circuit = this.circuitWorld();

    if (!points.length && !circuit) {
      return null;
    }

    // Equirectangular, scaled by cos(latitude) — the circuit's own anchor when
    // there is one, so both are projected into the same frame.
    const scale = circuit ? circuit.scale : Math.cos((points[0].lat * Math.PI) / 180);
    const project = (point: TracePoint) => ({ x: point.lon * scale, y: -point.lat });

    let minX = Infinity;
    let maxX = -Infinity;
    let minY = Infinity;
    let maxY = -Infinity;
    const trace: WorldPoint[] = [];

    for (const point of points) {
      const p = project(point);
      trace.push(p);
      // Bounds come from the circuit when there is one; the trace itself is
      // still drawn either way.
      if (!circuit) {
        minX = Math.min(minX, p.x);
        maxX = Math.max(maxX, p.x);
        minY = Math.min(minY, p.y);
        maxY = Math.max(maxY, p.y);
      }
    }

    const current = this.position();
    return {
      // Fit to the circuit rather than the moving trace — see the class docblock.
      bounds: circuit ? circuit.bounds : { minX, maxX, minY, maxY },
      minSpan: circuit ? undefined : MIN_SPAN_DEGREES,
      trace,
      marker: current ? project(current) : null,
      circuit: circuit ? { points: circuit.points, widthM: circuit.widthM } : null,
    };
  });

  constructor() {
    afterNextRender(() => this.viewport.observe(this.containerRef().nativeElement));

    afterRenderEffect({
      earlyRead: () => {
        const style = getComputedStyle(this.canvasRef().nativeElement);
        return {
          muted: style.getPropertyValue('--muted').trim() || '#8b93a1',
          accent: style.getPropertyValue('--accent').trim() || '#4aa3df',
        };
      },
      write: (colours) => {
        const canvas = this.canvasRef().nativeElement;
        const size = this.viewport.containerSize();
        if (size.width <= 0 || size.height <= 0) {
          return;
        }

        const ctx = sizeCanvasForDisplay(canvas, size.width, size.height);
        const dpr = window.devicePixelRatio || 1;
        const t = this.viewport.transform();

        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        ctx.clearRect(0, 0, size.width, size.height);

        const w = this.world();
        if (!w) {
          return;
        }

        ctx.setTransform(dpr * t.scale, 0, 0, dpr * t.scale, dpr * t.x, dpr * t.y);
        drawScene(ctx, w, t, colours());
      },
    });
  }
}

function drawScene(
  ctx: CanvasRenderingContext2D,
  w: WorldGeometry,
  t: ViewTransform,
  colours: { muted: string; accent: string },
): void {
  if (w.circuit) {
    ctx.beginPath();
    strokePolyline(ctx, w.circuit.points);
    ctx.strokeStyle = colours.muted;
    ctx.globalAlpha = 0.35;
    // True scale, deliberately not divided by t.scale — see racing-line.ts's
    // drawScene for why: with zoom available, zooming in is the honest way
    // to see a thin track surface clearly.
    ctx.lineWidth = w.circuit.widthM / METERS_PER_DEG_LAT;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.stroke();
    ctx.globalAlpha = 1;
  }

  if (w.trace.length > 1) {
    ctx.beginPath();
    strokePolyline(ctx, w.trace);
    ctx.strokeStyle = colours.accent;
    ctx.lineWidth = LINE_WIDTH_PX / t.scale;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.stroke();
  }

  if (w.marker) {
    ctx.beginPath();
    ctx.arc(w.marker.x, w.marker.y, CAR_RADIUS_PX / t.scale, 0, Math.PI * 2);
    ctx.fillStyle = '#e8543f';
    ctx.fill();
  }
}
