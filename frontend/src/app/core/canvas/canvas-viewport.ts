/**
 * Zoom/pan machinery shared by `racing-line.ts` and `track-trace.ts`.
 *
 * Deliberately framework-agnostic — no Angular imports — so it is plain,
 * fully unit-testable TypeScript. Both components need the same non-trivial
 * interaction logic (an affine world→screen transform, zoom-toward-cursor
 * math, devicePixelRatio-aware canvas sizing, resize observation, marker
 * hit-testing); two independently-drifting copies of that is a correctness
 * risk, not a style choice, unlike the three-line equirectangular projection
 * formula this codebase is comfortable duplicating per-component.
 */

/** An affine transform: `screenX = worldX * scale + x`, `screenY = worldY * scale + y`. */
export interface ViewTransform {
  scale: number;
  x: number;
  y: number;
}

export interface Bounds {
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
}

export interface Size {
  width: number;
  height: number;
}

/**
 * The transform that fits `bounds` into a `canvasWidth` × `canvasHeight`
 * viewport, centred, with `marginFraction` of breathing room around it.
 *
 * `minSpan` guards a degenerate (single-point, or zero-width/height) bounds
 * box — without it, a one-point circuit would divide by zero and produce a
 * transform with `NaN`/`Infinity` scale.
 */
export function fitTransform(
  bounds: Bounds,
  canvasWidth: number,
  canvasHeight: number,
  marginFraction: number,
  minSpan = 1e-6,
): ViewTransform {
  if (!(canvasWidth > 0) || !(canvasHeight > 0)) {
    return { scale: 1, x: 0, y: 0 };
  }

  const contentWidth = Math.max(bounds.maxX - bounds.minX, minSpan);
  const contentHeight = Math.max(bounds.maxY - bounds.minY, minSpan);
  const pad = Math.max(contentWidth, contentHeight) * marginFraction;
  const paddedWidth = contentWidth + pad * 2;
  const paddedHeight = contentHeight + pad * 2;

  const scale = Math.min(canvasWidth / paddedWidth, canvasHeight / paddedHeight);

  const centerX = (bounds.minX + bounds.maxX) / 2;
  const centerY = (bounds.minY + bounds.maxY) / 2;

  return {
    scale,
    x: canvasWidth / 2 - centerX * scale,
    y: canvasHeight / 2 - centerY * scale,
  };
}

export function worldToScreen(
  t: ViewTransform,
  worldX: number,
  worldY: number,
): { x: number; y: number } {
  return { x: worldX * t.scale + t.x, y: worldY * t.scale + t.y };
}

export function screenToWorld(
  t: ViewTransform,
  screenX: number,
  screenY: number,
): { x: number; y: number } {
  return { x: (screenX - t.x) / t.scale, y: (screenY - t.y) / t.scale };
}

/**
 * Zooms `t` by `factor`, clamped to `limits`, keeping the world point under
 * `(screenX, screenY)` fixed on screen — the standard "zoom toward the
 * cursor" behaviour, rather than zooming toward the view's centre.
 *
 * The factor actually applied is recomputed from the *clamped* scale, so the
 * fixed-point math stays correct even when the requested zoom is clamped
 * away — otherwise the content visibly jumps at the zoom limits.
 */
export function zoomAt(
  t: ViewTransform,
  screenX: number,
  screenY: number,
  factor: number,
  limits: { min: number; max: number },
): ViewTransform {
  const newScale = Math.min(limits.max, Math.max(limits.min, t.scale * factor));
  const actualFactor = newScale / t.scale;

  return {
    scale: newScale,
    x: screenX - (screenX - t.x) * actualFactor,
    y: screenY - (screenY - t.y) * actualFactor,
  };
}

export function pan(t: ViewTransform, dxScreen: number, dyScreen: number): ViewTransform {
  return { scale: t.scale, x: t.x + dxScreen, y: t.y + dyScreen };
}

/** A wheel notch in line mode, in CSS pixels — roughly one line of text. */
const WHEEL_LINE_PX = 16;
/** …and in page mode, where one notch is about a screenful. */
const WHEEL_PAGE_PX = 400;
/**
 * The most one event may contribute. A page-mode notch would otherwise jump
 * straight to the zoom limit, and a coarse mouse driver can report a single
 * enormous delta.
 */
const WHEEL_MAX_PX = 240;

/**
 * The zoom factor for one wheel event, normalised across browsers.
 *
 * **`deltaY` is only comparable within the same `deltaMode`,** and both zoom
 * surfaces used to multiply the raw number by a fixed constant. Chrome reports
 * pixels (~100 per notch, so ~10% zoom); Firefox — including on this project's
 * Linux dev machines — reports *lines*, ~3 per notch, which the same constant
 * turned into a **0.3% zoom**: roughly 700 notches to cross the zoom range,
 * i.e. a wheel that looks broken. jsdom defaults `deltaMode` to 0, so no test
 * could see it.
 *
 * Shared by the canvas views and `line-chart.ts` so the gesture feels the same
 * everywhere and this only has to be right once.
 */
export function wheelZoomFactor(event: WheelEvent, sensitivity = 0.001): number {
  const perUnit = event.deltaMode === 1 ? WHEEL_LINE_PX : event.deltaMode === 2 ? WHEEL_PAGE_PX : 1;
  const deltaPx = Math.max(-WHEEL_MAX_PX, Math.min(WHEEL_MAX_PX, event.deltaY * perUnit));

  return Math.exp(-deltaPx * sensitivity);
}

/**
 * Whether two transforms differ enough to be worth committing.
 *
 * Callers use this to avoid storing a no-op gesture as a user override. That
 * matters because an override permanently suspends auto-fit: scrolling to
 * zoom out while already at the zoom-out limit produces an identical
 * transform, and committing it would silently stop the live view following
 * the car with nothing on screen to explain why.
 */
export function transformsDiffer(a: ViewTransform, b: ViewTransform, epsilon = 1e-9): boolean {
  return (
    Math.abs(a.scale - b.scale) > epsilon ||
    Math.abs(a.x - b.x) > epsilon ||
    Math.abs(a.y - b.y) > epsilon
  );
}

/**
 * The index of the candidate nearest `(screenX, screenY)`, or `null` if
 * nothing is within `maxDistancePx` — hit-testing for hover tooltips on
 * braking-point and corner markers, done in screen space so the threshold
 * means the same number of pixels at any zoom level.
 */
export function nearestWithin(
  screenX: number,
  screenY: number,
  candidates: { x: number; y: number }[],
  maxDistancePx: number,
): number | null {
  let bestIndex: number | null = null;
  let bestDistance = maxDistancePx;

  for (let i = 0; i < candidates.length; i++) {
    const dx = candidates[i].x - screenX;
    const dy = candidates[i].y - screenY;
    const distance = Math.hypot(dx, dy);
    if (distance <= bestDistance) {
      bestDistance = distance;
      bestIndex = i;
    }
  }

  return bestIndex;
}

/**
 * Observes `el`'s content-box size, calling `onChange` on the initial
 * measurement and every resize after. Returns an unsubscribe function.
 */
export function observeSize(el: Element, onChange: (size: Size) => void): () => void {
  const observer = new ResizeObserver((entries) => {
    const entry = entries[0];
    if (!entry) {
      return;
    }
    onChange({ width: entry.contentRect.width, height: entry.contentRect.height });
  });

  observer.observe(el);
  return () => observer.disconnect();
}

/**
 * Sizes `canvas`'s backing store for `devicePixelRatio` at `cssWidth` ×
 * `cssHeight`, and sets its CSS size to match. Only touches `canvas.width`/
 * `height` when they actually need to change — writing them unconditionally
 * clears the canvas's content every call, which would otherwise erase and
 * immediately redraw every single frame for no reason.
 *
 * Does **not** apply any transform to the returned context — the caller sets
 * its own, since it needs to combine this sizing with pan/zoom in one
 * `setTransform` call rather than layering a second one on top.
 */
export function sizeCanvasForDisplay(
  canvas: HTMLCanvasElement,
  cssWidth: number,
  cssHeight: number,
): CanvasRenderingContext2D {
  const dpr = window.devicePixelRatio || 1;
  const targetWidth = Math.max(1, Math.round(cssWidth * dpr));
  const targetHeight = Math.max(1, Math.round(cssHeight * dpr));

  // Guarded together: assigning `width`/`height` clears the canvas, and the
  // two `style` writes are CSSOM writes on a path that runs at frame rate.
  // Both are no-ops when the size has not changed, and the size changes only
  // on a resize.
  if (canvas.width !== targetWidth || canvas.height !== targetHeight) {
    canvas.width = targetWidth;
    canvas.height = targetHeight;
    canvas.style.width = `${cssWidth}px`;
    canvas.style.height = `${cssHeight}px`;
  }

  const ctx = canvas.getContext('2d');
  if (!ctx) {
    throw new Error('2D canvas context unavailable');
  }
  return ctx;
}

/** A point in world space — projected, but not yet pan/zoomed to the screen. */
export interface WorldPoint {
  x: number;
  y: number;
}

/**
 * Trace a polyline into the current path. Caller owns `beginPath`/`stroke` and
 * the style, so a run of these can share one path where that is cheaper.
 */
export function strokePolyline(ctx: CanvasRenderingContext2D, points: WorldPoint[]): void {
  points.forEach((p, i) => (i === 0 ? ctx.moveTo(p.x, p.y) : ctx.lineTo(p.x, p.y)));
}
