import {
  Component,
  ElementRef,
  afterNextRender,
  afterRenderEffect,
  computed,
  input,
  signal,
  viewChild,
} from '@angular/core';
import { BrakingPoint, LapTracePoint } from '../../core/models/analysis.model';
import { TrackMapGeoJson, isCircuit, isCorner } from '../../core/models/track-map.model';
import {
  Bounds,
  ViewTransform,
  WorldPoint,
  nearestWithin,
  sizeCanvasForDisplay,
  strokePolyline,
  worldToScreen,
} from '../../core/canvas/canvas-viewport';
import { createCanvasViewport } from '../../core/canvas/viewport-controller';

/** Fraction of the track's own size left as padding around it, at the fitted (unzoomed) view. */
const MARGIN = 0.1;

/** How far past the fitted view a user can zoom in. Fitted view itself is the zoom-out limit. */
const MAX_ZOOM_MULTIPLIER = 40;

/** Metres per degree of latitude — good enough for a visual overlay's scale, not survey work. */
const METERS_PER_DEG_LAT = 111000;

/** Constant on-screen pixel sizes, independent of zoom — divided by `transform.scale` at draw
 * time, the canvas equivalent of SVG's `vector-effect: non-scaling-stroke`. */
const LINE_WIDTH_PX = 3;
const GHOST_WIDTH_PX = 2;
const BRAKE_RADIUS_PX = 5;
const CORNER_RADIUS_PX = 4;
/** How close a hover has to land on a marker to count, in screen pixels. */
const HIT_RADIUS_PX = 12;

const BRAKE_COLOUR = '#e8543f';

interface WorldGeometry {
  bounds: Bounds;
  bands: { points: WorldPoint[]; colour: string }[];
  ghost: WorldPoint[] | null;
  braking: (WorldPoint & BrakingPoint)[];
  circuit: { points: WorldPoint[]; widthM: number } | null;
  corners: { name: string; x: number; y: number }[];
}

interface Hovered {
  x: number;
  y: number;
  label: string;
}

/**
 * The racing line for one lap, with the reference lap ghosted underneath, the
 * braking points marked, and — when `TrackMapService` has one — the circuit
 * itself underneath all of it. Zoomable and pannable: wheel or pinch to zoom,
 * drag to pan, "Reset view" to fit the whole lap again.
 *
 * **Canvas, not SVG — this used to be SVG.** Two rounds of feedback pushed on
 * the same real limit: `viewBox` auto-fits, but has no interactive zoom, so
 * there was no way to get closer than "the whole circuit, scaled to fit the
 * panel" to compare two laps through one corner. Canvas gets the same vector
 * geometry drawn through an explicit, user-controlled transform instead of a
 * fixed one.
 *
 * **The tile-basemap question this used to defer is still answered the same
 * way.** The outline is vector geometry `TrackMapService` fetched from
 * OpenStreetMap once, server-side — no tile provider, no API key, no third
 * party learning which circuit a named driver's traces are on.
 *
 * The line is coloured by speed rather than drawn flat: the shape alone
 * cannot show that two laps took the same corner at different speeds, and
 * that is usually the thing being looked for.
 */
@Component({
  selector: 'app-racing-line',
  template: `
    <div class="stage" #container>
      <canvas
        #canvas
        class="canvas"
        [class.dragging]="viewport.isDragging()"
        role="img"
        [attr.aria-label]="ariaLabel()"
        (wheel)="viewport.onWheel($event)"
        (pointerdown)="viewport.onPointerDown($event)"
        (pointermove)="onPointerMove($event)"
        (pointerup)="viewport.onPointerUp($event)"
        (pointercancel)="viewport.onPointerUp($event)"
        (pointerleave)="onPointerLeave()"
      ></canvas>

      @if (!world()) {
        <p class="empty">No trace for this lap.</p>
      } @else {
        <button type="button" class="reset" (click)="viewport.resetView()">Reset view</button>

        @if (hovered(); as h) {
          <div class="tooltip" [style.left.px]="h.x" [style.top.px]="h.y">{{ h.label }}</div>
        }
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
      /* Stops the browser's own touch scroll/pinch from fighting the pointer
         handlers below, which implement pan and pinch-zoom themselves. */
      touch-action: none;
      cursor: grab;

      &.dragging {
        cursor: grabbing;
      }
    }
    .reset {
      position: absolute;
      inset-block-start: 0.6rem;
      inset-inline-end: 0.6rem;
      font: inherit;
      font-size: 0.75rem;
      padding: 0.3rem 0.7rem;
      border: 1px solid var(--border);
      border-radius: 0.4rem;
      background: var(--surface);
      color: var(--text);
      cursor: pointer;

      &:hover {
        border-color: var(--accent);
      }
    }
    .tooltip {
      position: absolute;
      transform: translate(-50%, -130%);
      background: var(--surface);
      border: 1px solid var(--border);
      border-radius: 0.3rem;
      padding: 0.25rem 0.5rem;
      font-size: 0.75rem;
      white-space: nowrap;
      pointer-events: none;
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
export class RacingLine {
  readonly points = input.required<LapTracePoint[]>();
  readonly ghostPoints = input<LapTracePoint[]>([]);
  readonly brakingPoints = input<BrakingPoint[]>([]);
  readonly trackMap = input<TrackMapGeoJson | null>(null);
  /** Changing this resets zoom/pan to fit — bind the session id, not the lap number. */
  readonly resetKey = input<unknown>(undefined);

  private readonly containerRef = viewChild.required<ElementRef<HTMLDivElement>>('container');
  private readonly canvasRef = viewChild.required<ElementRef<HTMLCanvasElement>>('canvas');

  protected readonly hovered = signal<Hovered | null>(null);

  /**
   * Pan/pinch/wheel zoom and the fitted view, shared with the live view's
   * track trace — see `createCanvasViewport`. Hover is this view's own, so it
   * stays here and hooks in through `onGestureStart`.
   */
  protected readonly viewport = createCanvasViewport({
    fitTo: () => this.world(),
    canvas: () => this.canvasRef()?.nativeElement,
    margin: MARGIN,
    maxZoomMultiplier: MAX_ZOOM_MULTIPLIER,
    resetKey: () => this.resetKey(),
    onGestureStart: () => this.hovered.set(null),
  });

  /**
   * The circuit and its corner labels, projected once per track.
   *
   * Split out of `world` for the same reason as the live view's copy: none of
   * this depends on which lap is selected, but `world` re-runs on every lap
   * click, every compare-lap toggle and every braking-point change. Folded in,
   * a lap switch re-projected the whole ring and re-walked ~32 corner features
   * to produce exactly what it had before.
   *
   * The projection is anchored on the circuit's own first point rather than
   * the lap's, so it does not shift when the selected lap changes — and so
   * this view and the live view project the same circuit identically.
   */
  private readonly circuitWorld = computed(() => {
    const map = this.trackMap();
    const circuit = map?.features.find(isCircuit) ?? null;
    if (!circuit) {
      return null;
    }

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
      corners: (map?.features.filter(isCorner) ?? []).map((feature) => {
        const mid =
          feature.geometry.coordinates[Math.floor(feature.geometry.coordinates.length / 2)];
        return { name: feature.properties.name, x: mid[0] * scale, y: -mid[1] };
      }),
    };
  });

  /**
   * World-space geometry: projected points, bounds, circuit and markers.
   * Nothing pixel- or zoom-specific lives here — that is `transform`'s job —
   * so switching laps, the reference lap or the track map never has to be
   * kept in step with the current pan/zoom by hand.
   */
  protected readonly world = computed<WorldGeometry | null>(() => {
    const points = this.points();
    if (points.length < 2) {
      return null;
    }

    // Equirectangular, scaled by cos(latitude): a degree of longitude is
    // shorter than a degree of latitude everywhere but the equator, and
    // without this a circuit comes out visibly stretched east-west.
    const circuit = this.circuitWorld();
    const scale = circuit ? circuit.scale : Math.cos((points[0].lat * Math.PI) / 180);
    const x = (p: { lon: number }) => p.lon * scale;
    const y = (p: { lat: number }) => -p.lat;

    const ghost = this.ghostPoints();

    let minX = circuit ? circuit.bounds.minX : Infinity;
    let maxX = circuit ? circuit.bounds.maxX : -Infinity;
    let minY = circuit ? circuit.bounds.minY : Infinity;
    let maxY = circuit ? circuit.bounds.maxY : -Infinity;

    // Bounds over the lap, the ghost and the circuit, so the whole layout is
    // framed rather than clipped and switching the comparison or the track
    // never makes the fitted view jump.
    for (const point of [...points, ...ghost]) {
      const px = x(point);
      const py = y(point);
      minX = Math.min(minX, px);
      maxX = Math.max(maxX, px);
      minY = Math.min(minY, py);
      maxY = Math.max(maxY, py);
    }

    return {
      bounds: { minX, maxX, minY, maxY },
      bands: speedBands(points, x, y),
      ghost: ghost.length > 1 ? ghost.map((p) => ({ x: x(p), y: y(p) })) : null,
      braking: this.brakingPoints().map((marker) => ({ ...marker, x: x(marker), y: y(marker) })),
      circuit: circuit ? { points: circuit.points, widthM: circuit.widthM } : null,
      corners: circuit ? circuit.corners : [],
    };
  });

  protected readonly ariaLabel = computed(() =>
    this.world()
      ? 'Racing line for the selected lap. Scroll or pinch to zoom, drag to pan.'
      : 'No trace for this lap.',
  );

  constructor() {
    afterNextRender(() => this.viewport.observe(this.containerRef().nativeElement));

    afterRenderEffect({
      // Custom-property colours are DOM-dependent, so they belong in earlyRead, not write.
      earlyRead: () => {
        const style = getComputedStyle(this.canvasRef().nativeElement);
        return {
          muted: style.getPropertyValue('--muted').trim() || '#8b93a1',
          bg: style.getPropertyValue('--bg').trim() || '#0d1117',
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

        // Clear in plain CSS-pixel space, then switch to the pan/zoom transform
        // for the actual drawing — clearing *after* setting that transform would
        // need clearRect's own bounds inverse-transformed to still cover the
        // whole visible canvas, which is needless complexity for the same result.
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        ctx.clearRect(0, 0, size.width, size.height);

        const w = this.world();
        if (!w) {
          return;
        }

        ctx.setTransform(dpr * t.scale, 0, 0, dpr * t.scale, dpr * t.x, dpr * t.y);
        // `write` receives the previous phase's result as a Signal, not a plain
        // value — call it to read the colours earlyRead resolved.
        drawScene(ctx, w, t, colours());
      },
    });
  }

  /**
   * Hover is this view's own: with no pointer down, a move is a hover over the
   * braking/corner markers rather than a pan, so the viewport never sees it.
   */
  protected onPointerMove(event: PointerEvent): void {
    if (!this.viewport.isGesturing()) {
      this.handleHover(event);
      return;
    }
    this.viewport.onPointerMove(event);
  }

  protected onPointerLeave(): void {
    this.hovered.set(null);
  }

  private handleHover(event: PointerEvent): void {
    const w = this.world();
    if (!w) {
      this.hovered.set(null);
      return;
    }

    const rect = this.canvasRef().nativeElement.getBoundingClientRect();
    const sx = event.clientX - rect.left;
    const sy = event.clientY - rect.top;
    const t = this.viewport.transform();

    const brakeHit = nearestWithin(
      sx,
      sy,
      w.braking.map((m) => worldToScreen(t, m.x, m.y)),
      HIT_RADIUS_PX,
    );
    if (brakeHit != null) {
      const m = w.braking[brakeHit];
      this.hovered.set({
        x: sx,
        y: sy,
        label: `Braking at ${m.distM} m — ${m.entrySpeedKmh} km/h, ${m.peakDecelG} g`,
      });
      return;
    }

    const cornerHit = nearestWithin(
      sx,
      sy,
      w.corners.map((c) => worldToScreen(t, c.x, c.y)),
      HIT_RADIUS_PX,
    );
    this.hovered.set(cornerHit != null ? { x: sx, y: sy, label: w.corners[cornerHit].name } : null);
  }
}

/**
 * The speed palette: slow to fast.
 *
 * Five steps rather than a continuous gradient because a stroke cannot carry
 * a gradient *along* it without a mask, and because five is as many as a
 * reader can tell apart at a glance on a 3 px line. Blue-to-red is the
 * convention every telemetry tool uses for this, so it needs no legend.
 */
const SPEED_COLOURS = ['#3f7fe8', '#4aa3df', '#5fc9a8', '#e8c14a', '#e8543f'];

/**
 * The lap split into runs of constant speed band, one polyline each.
 *
 * Runs rather than one stroke per segment: a 800-point lap is 799 segments,
 * and 799 individual `stroke()` calls (each with its own colour) is real
 * per-frame cost for no visible gain. Consecutive segments in the same band
 * share a polyline, which on a real circuit collapses it to a few dozen.
 *
 * Each run repeats its predecessor's last point, or the line would have a
 * one-segment gap at every band change.
 */
function speedBands(
  points: LapTracePoint[],
  x: (p: { lon: number }) => number,
  y: (p: { lat: number }) => number,
): { points: WorldPoint[]; colour: string }[] {
  let min = Infinity;
  let max = -Infinity;
  for (const point of points) {
    if (point.speedKmh == null) {
      continue;
    }
    min = Math.min(min, point.speedKmh);
    max = Math.max(max, point.speedKmh);
  }

  // No speed channel at all — a replayed dash session record, for one. Draw
  // the shape in a single colour rather than nothing.
  if (!Number.isFinite(min) || max - min < 1e-9) {
    return [{ points: points.map((p) => ({ x: x(p), y: y(p) })), colour: SPEED_COLOURS[1] }];
  }

  const bandOf = (speed: number | null) =>
    speed == null
      ? 0
      : Math.min(
          SPEED_COLOURS.length - 1,
          Math.floor(((speed - min) / (max - min)) * SPEED_COLOURS.length),
        );

  const bands: { points: WorldPoint[]; colour: string }[] = [];
  let current = -1;
  let run: WorldPoint[] = [];

  for (const point of points) {
    const band = bandOf(point.speedKmh);
    const pt = { x: x(point), y: y(point) };

    if (band !== current) {
      if (run.length) {
        // Close the previous run *through* this point, then start here.
        run.push(pt);
        bands.push({ points: run, colour: SPEED_COLOURS[current] });
      }
      run = [pt];
      current = band;
      continue;
    }

    run.push(pt);
  }

  if (run.length && current >= 0) {
    bands.push({ points: run, colour: SPEED_COLOURS[current] });
  }

  return bands;
}

function drawScene(
  ctx: CanvasRenderingContext2D,
  w: WorldGeometry,
  t: ViewTransform,
  colours: { muted: string; bg: string },
): void {
  if (w.circuit) {
    ctx.beginPath();
    strokePolyline(ctx, w.circuit.points);
    ctx.strokeStyle = colours.muted;
    ctx.globalAlpha = 0.35;
    // True scale, deliberately not divided by t.scale: with zoom available,
    // the honest way to see a thin track surface clearly is to zoom in on
    // it, not to fake its width relative to the view.
    ctx.lineWidth = w.circuit.widthM / METERS_PER_DEG_LAT;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.stroke();
    ctx.globalAlpha = 1;
  }

  if (w.ghost) {
    ctx.beginPath();
    strokePolyline(ctx, w.ghost);
    ctx.strokeStyle = colours.muted;
    ctx.globalAlpha = 0.5;
    ctx.lineWidth = GHOST_WIDTH_PX / t.scale;
    ctx.setLineDash([6 / t.scale, 5 / t.scale]);
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.globalAlpha = 1;
  }

  for (const band of w.bands) {
    ctx.beginPath();
    strokePolyline(ctx, band.points);
    ctx.strokeStyle = band.colour;
    ctx.lineWidth = LINE_WIDTH_PX / t.scale;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.stroke();
  }

  const brakeRadius = BRAKE_RADIUS_PX / t.scale;
  ctx.fillStyle = BRAKE_COLOUR;
  ctx.strokeStyle = colours.bg;
  ctx.lineWidth = 1 / t.scale;
  for (const marker of w.braking) {
    ctx.beginPath();
    ctx.arc(marker.x, marker.y, brakeRadius, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
  }

  const cornerRadius = CORNER_RADIUS_PX / t.scale;
  ctx.fillStyle = colours.bg;
  ctx.strokeStyle = colours.muted;
  ctx.globalAlpha = 0.7;
  ctx.lineWidth = 1 / t.scale;
  for (const corner of w.corners) {
    ctx.beginPath();
    ctx.arc(corner.x, corner.y, cornerRadius, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
  }
  ctx.globalAlpha = 1;
}
