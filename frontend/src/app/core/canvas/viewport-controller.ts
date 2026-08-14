import { DestroyRef, Signal, computed, inject, linkedSignal, signal } from '@angular/core';
import {
  Bounds,
  ViewTransform,
  fitTransform,
  observeSize,
  pan,
  transformsDiffer,
  zoomAt,
} from './canvas-viewport';

/** What the view should frame, plus an optional floor on how small a span may be fitted. */
export interface ViewportFit {
  bounds: Bounds;
  /** Guards against fitting to GPS jitter when the only geometry is a stationary car. */
  minSpan?: number;
}

export interface CanvasViewportOptions {
  /** The geometry to frame, or `null` while there is nothing to draw. */
  fitTo: () => ViewportFit | null;
  /** The canvas itself — pointer coordinates are taken relative to it. */
  canvas: () => HTMLCanvasElement | undefined;
  /** Fraction of the geometry's own size left as padding at the fitted view. */
  margin: number;
  /** How far past the fitted view a user may zoom in. */
  maxZoomMultiplier: number;
  /** Changing this resets pan/zoom back to the fit. */
  resetKey: () => unknown;
  /** Fired when a gesture begins — the analysis view drops its hover tooltip on it. */
  onGestureStart?: () => void;
}

/**
 * Pan, pinch and wheel zoom over a fitted canvas view.
 *
 * `canvas-viewport.ts` next door holds the pure arithmetic — `fitTransform`,
 * `zoomAt`, `pan`. This holds the *state* that calls it: the pointer book-keeping,
 * the fit/override split, and the wiring that keeps a `ResizeObserver` in step
 * with a signal. Both canvas views (the analysis racing line and the live track
 * trace) had their own verbatim copy of all of it — roughly 130 lines each,
 * including the whole two-pointer pinch branch — with only the margin, an
 * optional `minSpan` and one hover hook actually differing between them.
 *
 * That split was the wrong seam: `canvas-viewport.ts`'s own docblock says two
 * independently drifting copies of the interaction logic is "a correctness
 * risk, not a style choice", and then only the arithmetic was shared. The
 * copies had already begun to drift.
 *
 * Create it in an injection context (a field initializer is one) and call
 * `observe()` from `afterNextRender`, once the container element exists.
 */
export function createCanvasViewport(options: CanvasViewportOptions) {
  const destroyRef = inject(DestroyRef);

  const containerSize = signal({ width: 0, height: 0 });
  const isDragging = signal(false);

  /** Pointers currently down, keyed by pointerId — one is a pan, two are a pinch. */
  const activePointers = new Map<number, { x: number; y: number }>();
  let previousPinch: { distance: number; midX: number; midY: number } | null = null;

  /**
   * `null` means "not overridden, follow the fit". Resets to `null` whenever
   * `resetKey` changes; freely set by the user's gestures in between.
   * `linkedSignal` rather than a manual reset `effect`, per Angular's own
   * guidance: state derived from another signal but user-overridable is
   * exactly what it is for.
   */
  const userTransform = linkedSignal<unknown, ViewTransform | null>({
    source: () => options.resetKey(),
    computation: () => null,
  });

  /**
   * The view that frames the geometry. Its own computed because the zoom
   * limits need the same number — computing the fit twice meant the zoom-out
   * floor could silently stop matching the fitted view.
   */
  const fit = computed<ViewTransform>(() => {
    const target = options.fitTo();
    const size = containerSize();
    return target
      ? fitTransform(target.bounds, size.width, size.height, options.margin, target.minSpan)
      : { scale: 1, x: 0, y: 0 };
  });

  const transform = computed<ViewTransform>(() => userTransform() ?? fit());

  /** Zoom out no further than the fitted view; zoom in far enough to read one corner. */
  const zoomLimits = () => {
    const { scale } = fit();
    return { min: scale, max: scale * options.maxZoomMultiplier };
  };

  const pinchState = () => {
    const pointers = [...activePointers.values()];
    if (pointers.length < 2) {
      return null;
    }
    const [a, b] = pointers;
    return {
      distance: Math.hypot(b.x - a.x, b.y - a.y),
      midX: (a.x + b.x) / 2,
      midY: (a.y + b.y) / 2,
    };
  };

  const rect = () => options.canvas()?.getBoundingClientRect();

  return {
    containerSize: containerSize.asReadonly(),
    isDragging: isDragging.asReadonly(),
    transform,

    /** True while at least one pointer is down — the hover state's cue to stand down. */
    isGesturing: (): boolean => activePointers.size > 0,

    /** Wire the container's size to `containerSize`. Call from `afterNextRender`. */
    observe(container: HTMLElement): void {
      const unobserve = observeSize(container, (size) => containerSize.set(size));
      destroyRef.onDestroy(unobserve);
    },

    resetView(): void {
      userTransform.set(null);
    },

    onWheel(event: WheelEvent): void {
      event.preventDefault();
      const bounds = rect();
      if (!bounds) {
        return;
      }

      const factor = Math.exp(-event.deltaY * 0.001);
      const current = transform();
      const zoomed = zoomAt(
        current,
        event.clientX - bounds.left,
        event.clientY - bounds.top,
        factor,
        zoomLimits(),
      );

      // Only commit a zoom that actually changed something — a clamped no-op
      // would otherwise pin the view, suspending the auto-fit that keeps the
      // frame following a lap or track-map change.
      if (transformsDiffer(current, zoomed)) {
        userTransform.set(zoomed);
      }
    },

    onPointerDown(event: PointerEvent): void {
      (event.target as HTMLElement).setPointerCapture(event.pointerId);
      activePointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
      isDragging.set(true);
      options.onGestureStart?.();
      previousPinch = pinchState();
    },

    onPointerMove(event: PointerEvent): void {
      if (!activePointers.has(event.pointerId)) {
        return;
      }

      const previous = activePointers.get(event.pointerId)!;
      activePointers.set(event.pointerId, { x: event.clientX, y: event.clientY });

      if (activePointers.size === 1) {
        userTransform.set(pan(transform(), event.clientX - previous.x, event.clientY - previous.y));
        return;
      }

      if (activePointers.size === 2) {
        const before = previousPinch;
        const after = pinchState();
        previousPinch = after;
        const bounds = rect();
        if (!before || !after || !bounds) {
          return;
        }

        const factor = before.distance > 0 ? after.distance / before.distance : 1;
        const zoomed = zoomAt(
          transform(),
          after.midX - bounds.left,
          after.midY - bounds.top,
          factor,
          zoomLimits(),
        );
        userTransform.set(pan(zoomed, after.midX - before.midX, after.midY - before.midY));
      }
    },

    onPointerUp(event: PointerEvent): void {
      activePointers.delete(event.pointerId);
      previousPinch = pinchState();
      if (activePointers.size === 0) {
        isDragging.set(false);
      }
    },
  };
}

export type CanvasViewport = ReturnType<typeof createCanvasViewport> & {
  transform: Signal<ViewTransform>;
};
