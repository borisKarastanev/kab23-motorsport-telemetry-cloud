import { TestBed } from '@angular/core/testing';
import { signal } from '@angular/core';

import { CanvasViewportOptions, createCanvasViewport } from './viewport-controller';

class FakeResizeObserver {
  private cb: ResizeObserverCallback;
  static observed: Element[] = [];
  static disconnected = 0;
  constructor(cb: ResizeObserverCallback) {
    this.cb = cb;
  }
  observe(el: Element): void {
    FakeResizeObserver.observed.push(el);
    this.cb([{ contentRect: { width: 400, height: 300 } } as ResizeObserverEntry], this as unknown as ResizeObserver);
  }
  unobserve(): void {}
  disconnect(): void {
    FakeResizeObserver.disconnected++;
  }
}

function makeCanvas(rect: Partial<DOMRect> = {}): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  vi.spyOn(canvas, 'getBoundingClientRect').mockReturnValue({
    left: 0,
    top: 0,
    width: 400,
    height: 300,
    right: 400,
    bottom: 300,
    x: 0,
    y: 0,
    toJSON: () => ({}),
    ...rect,
  } as DOMRect);
  return canvas;
}

describe('createCanvasViewport', () => {
  let canvasEl: HTMLCanvasElement;
  let resetKey: ReturnType<typeof signal<unknown>>;
  let onGestureStart: ReturnType<typeof vi.fn<() => void>>;

  const build = (overrides: Partial<CanvasViewportOptions> = {}) => {
    canvasEl = makeCanvas();
    resetKey = signal<unknown>('session-1');
    onGestureStart = vi.fn<() => void>();

    const options: CanvasViewportOptions = {
      fitTo: () => ({ bounds: { minX: 0, maxX: 10, minY: 0, maxY: 10 } }),
      canvas: () => canvasEl,
      margin: 0.1,
      maxZoomMultiplier: 10,
      resetKey: () => resetKey(),
      onGestureStart: () => onGestureStart(),
      ...overrides,
    };

    return TestBed.runInInjectionContext(() => createCanvasViewport(options));
  };

  beforeEach(() => {
    TestBed.configureTestingModule({});
    (globalThis as unknown as { ResizeObserver: typeof ResizeObserver }).ResizeObserver =
      FakeResizeObserver as unknown as typeof ResizeObserver;
    FakeResizeObserver.observed = [];
    FakeResizeObserver.disconnected = 0;
  });

  it('follows the fitted transform until the user overrides it', () => {
    const viewport = build();
    const fitted = viewport.transform();

    expect(fitted.scale).toBeGreaterThan(0);
  });

  it('falls back to identity when there is nothing to fit', () => {
    const viewport = build({ fitTo: () => null });

    expect(viewport.transform()).toEqual({ scale: 1, x: 0, y: 0 });
  });

  it('wires a ResizeObserver on observe() and reflects the reported size', () => {
    const container = document.createElement('div');
    const viewport = build();

    viewport.observe(container);

    expect(FakeResizeObserver.observed).toContain(container);
    expect(viewport.containerSize()).toEqual({ width: 400, height: 300 });
  });

  describe('resetView / resetKey', () => {
    it('resets a user zoom override back to the fit', () => {
      const viewport = build();
      const before = viewport.transform();

      viewport.onWheel(new WheelEvent('wheel', { deltaY: -100, clientX: 50, clientY: 50 }));
      expect(viewport.transform()).not.toEqual(before);

      viewport.resetView();
      expect(viewport.transform()).toEqual(before);
    });

    it('clears a user override whenever resetKey changes', () => {
      const viewport = build();
      const fitted = viewport.transform();

      viewport.onWheel(new WheelEvent('wheel', { deltaY: -100, clientX: 50, clientY: 50 }));
      expect(viewport.transform()).not.toEqual(fitted);

      // A different lap/session id — the override must not survive it.
      resetKey.set('session-2');

      expect(viewport.transform()).toEqual(fitted);
    });
  });

  describe('onWheel', () => {
    it('zooms in on a negative deltaY and commits the change', () => {
      const viewport = build();
      const before = viewport.transform().scale;

      const event = new WheelEvent('wheel', { deltaY: -100, clientX: 50, clientY: 50, cancelable: true });
      const preventSpy = vi.spyOn(event, 'preventDefault');
      viewport.onWheel(event);

      expect(preventSpy).toHaveBeenCalled();
      expect(viewport.transform().scale).toBeGreaterThan(before);
    });

    it('does nothing when the canvas is not yet available', () => {
      const viewport = build({ canvas: () => undefined });
      const before = viewport.transform();

      viewport.onWheel(new WheelEvent('wheel', { deltaY: -100, clientX: 50, clientY: 50 }));

      expect(viewport.transform()).toEqual(before);
    });

    it('does not commit a clamped no-op zoom as a user override', () => {
      // Already at the (implicit) zoom-out floor — zooming out further is a no-op.
      const viewport = build();
      const before = viewport.transform();

      viewport.onWheel(new WheelEvent('wheel', { deltaY: 100000, clientX: 50, clientY: 50 }));

      // Clamped to the same fitted scale, so this must not suspend auto-fit.
      expect(viewport.transform()).toEqual(before);
    });
  });

  describe('pointer gestures', () => {
    it('starts dragging and notifies onGestureStart on pointer down', () => {
      const viewport = build();

      viewport.onPointerDown(makePointerEvent('pointerdown', 1, 10, 10));

      expect(viewport.isDragging()).toBe(true);
      expect(viewport.isGesturing()).toBe(true);
      expect(onGestureStart).toHaveBeenCalled();
    });

    it('pans with a single active pointer', () => {
      const viewport = build();

      viewport.onPointerDown(makePointerEvent('pointerdown', 1, 0, 0));
      const before = viewport.transform();

      viewport.onPointerMove(makePointerEvent('pointermove', 1, 10, 4));

      const after = viewport.transform();
      expect(after.x).toBeCloseTo(before.x + 10);
      expect(after.y).toBeCloseTo(before.y + 4);
    });

    it('ignores a move from a pointer that never went down', () => {
      const viewport = build();
      const before = viewport.transform();

      viewport.onPointerMove(makePointerEvent('pointermove', 99, 10, 10));

      expect(viewport.transform()).toEqual(before);
    });

    it('pinch-zooms with two active pointers', () => {
      const viewport = build();

      viewport.onPointerDown(makePointerEvent('pointerdown', 1, 100, 100));
      viewport.onPointerDown(makePointerEvent('pointerdown', 2, 200, 100));
      const before = viewport.transform().scale;

      // Pointers move apart — pinch out, zoom in.
      viewport.onPointerMove(makePointerEvent('pointermove', 1, 80, 100));
      viewport.onPointerMove(makePointerEvent('pointermove', 2, 220, 100));

      expect(viewport.transform().scale).toBeGreaterThan(before);
    });

    it('stops dragging once every pointer has lifted', () => {
      const viewport = build();

      viewport.onPointerDown(makePointerEvent('pointerdown', 1, 0, 0));
      expect(viewport.isDragging()).toBe(true);

      viewport.onPointerUp(makePointerEvent('pointerup', 1, 0, 0));

      expect(viewport.isDragging()).toBe(false);
      expect(viewport.isGesturing()).toBe(false);
    });
  });
});

function makePointerEvent(
  type: string,
  pointerId: number,
  clientX: number,
  clientY: number,
): PointerEvent {
  const event = new PointerEvent(type, { pointerId, clientX, clientY, bubbles: true });
  Object.defineProperty(event, 'target', { value: document.createElement('canvas'), configurable: true });
  Object.defineProperty(event.target as HTMLElement, 'setPointerCapture', {
    value: vi.fn(),
    configurable: true,
  });
  return event;
}
