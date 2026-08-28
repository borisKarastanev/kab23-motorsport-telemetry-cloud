import { ComponentFixture, TestBed } from '@angular/core/testing';

import { RacingLine } from './racing-line';
import { BrakingPoint, LapTracePoint } from '../../core/models/analysis.model';
import { TrackMapGeoJson } from '../../core/models/track-map.model';

/**
 * jsdom implements neither `ResizeObserver` nor `HTMLCanvasElement#getContext`
 * (there is no `canvas` npm package in this project — nothing actually needs
 * to rasterize). Without both, `viewport.containerSize` never leaves `{0,0}`
 * and the `afterRenderEffect`'s draw guard bails before calling
 * `sizeCanvasForDisplay`, so `drawScene`/`speedBands` never ran under test.
 * Stubbing both unlocks that whole path — see `canvasContext()` below.
 */
class FakeResizeObserver {
  private cb: ResizeObserverCallback;
  constructor(cb: ResizeObserverCallback) {
    this.cb = cb;
  }
  observe(): void {
    this.cb(
      [{ contentRect: { width: 400, height: 300 } } as ResizeObserverEntry],
      this as unknown as ResizeObserver,
    );
  }
  unobserve(): void {}
  disconnect(): void {}
}

function fakeCanvasContext() {
  const ctx = {
    beginPath: vi.fn(),
    moveTo: vi.fn(),
    lineTo: vi.fn(),
    stroke: vi.fn(),
    arc: vi.fn(),
    fill: vi.fn(),
    setLineDash: vi.fn(),
    clearRect: vi.fn(),
    setTransform: vi.fn(),
    fillStyle: '',
    lineWidth: 0,
    lineCap: '',
    lineJoin: '',
    globalAlpha: 1,
    /** Every value `strokeStyle` was set to, in order — a plain property only keeps the last. */
    strokeStyleHistory: [] as string[],
  };
  let strokeStyle = '';
  Object.defineProperty(ctx, 'strokeStyle', {
    get: () => strokeStyle,
    set: (value: string) => {
      strokeStyle = value;
      ctx.strokeStyleHistory.push(value);
    },
  });
  return ctx;
}

function tracePoint(overrides: Partial<LapTracePoint> = {}): LapTracePoint {
  return {
    distM: 0,
    elapsedMs: 0,
    lat: 0,
    lon: 0,
    speedKmh: 150,
    rpm: 6000,
    coolantC: 90,
    oilC: 95,
    gLat: 0,
    gLon: 0,
    ...overrides,
  };
}

// Two points on the equator, where the equirectangular projection's
// cos(latitude) scale factor is exactly 1 — world coordinates equal (lon, -lat)
// with no scaling, which is what keeps the hit-testing math below simple.
const TWO_POINTS: LapTracePoint[] = [
  tracePoint({ distM: 0, lon: 0, lat: 0 }),
  tracePoint({ distM: 100, lon: 0.01, lat: 0 }),
];

describe('RacingLine', () => {
  let fixture: ComponentFixture<RacingLine>;

  beforeEach(() => {
    TestBed.configureTestingModule({ imports: [RacingLine] });
    fixture = TestBed.createComponent(RacingLine);
  });

  const setPoints = (points: LapTracePoint[]) => {
    fixture.componentRef.setInput('points', points);
    fixture.detectChanges();
  };

  it('shows the empty state and a matching aria-label with fewer than two points', () => {
    setPoints([tracePoint()]);

    const empty = fixture.nativeElement.querySelector('.empty');
    expect(empty?.textContent).toContain('No trace for this lap.');
    const canvas = fixture.nativeElement.querySelector('canvas');
    expect(canvas.getAttribute('aria-label')).toBe('No trace for this lap.');
    expect(fixture.nativeElement.querySelector('.reset')).toBeFalsy();
  });

  it('shows the empty state for zero points, without throwing', () => {
    expect(() => setPoints([])).not.toThrow();
    expect(fixture.nativeElement.querySelector('.empty')).toBeTruthy();
  });

  it('renders the canvas and reset control once there is a trace', () => {
    setPoints(TWO_POINTS);

    expect(fixture.nativeElement.querySelector('.empty')).toBeFalsy();
    expect(fixture.nativeElement.querySelector('.reset')).toBeTruthy();
    const canvas = fixture.nativeElement.querySelector('canvas');
    expect(canvas.getAttribute('aria-label')).toBe(
      'Racing line for the selected lap. Scroll or pinch to zoom, drag to pan.',
    );
  });

  it('resets the view when "Reset view" is clicked', () => {
    setPoints(TWO_POINTS);

    const resetSpy = vi.spyOn(
      (fixture.componentInstance as unknown as { viewport: { resetView: () => void } }).viewport,
      'resetView',
    );
    (fixture.nativeElement.querySelector('.reset') as HTMLButtonElement).click();

    expect(resetSpy).toHaveBeenCalled();
  });

  describe('hover', () => {
    const brakingPoint: BrakingPoint = {
      distM: 50,
      lat: 0,
      // World x equals lon (scale 1 at the equator); kept small so it stays
      // within canvas-viewport's fitted-identity transform used before any
      // real container size has been observed.
      lon: 0.005,
      entrySpeedKmh: 80,
      peakDecelG: 1.2,
    };

    beforeEach(() => {
      fixture.componentRef.setInput('brakingPoints', [brakingPoint]);
      setPoints(TWO_POINTS);
    });

    const canvas = () => fixture.nativeElement.querySelector('canvas') as HTMLCanvasElement;

    const move = (x: number, y: number) => {
      canvas().dispatchEvent(
        new PointerEvent('pointermove', { clientX: x, clientY: y, bubbles: true }),
      );
      fixture.detectChanges();
    };

    it('shows a tooltip when the pointer lands on a braking marker', () => {
      // No container has been observed, so canvas-viewport's fit() is the
      // identity transform — screen coordinates equal the marker's world
      // coordinates (lon, -lat) directly.
      move(brakingPoint.lon, -brakingPoint.lat);

      const tooltip = fixture.nativeElement.querySelector('.tooltip');
      expect(tooltip?.textContent).toContain('Braking at 50 m — 80 km/h, 1.2 g');
    });

    it('shows no tooltip when the pointer is far from every marker', () => {
      move(1000, 1000);

      expect(fixture.nativeElement.querySelector('.tooltip')).toBeFalsy();
    });

    it('clears the tooltip on pointer leave', () => {
      move(brakingPoint.lon, -brakingPoint.lat);
      expect(fixture.nativeElement.querySelector('.tooltip')).toBeTruthy();

      canvas().dispatchEvent(new PointerEvent('pointerleave', { bubbles: true }));
      fixture.detectChanges();

      expect(fixture.nativeElement.querySelector('.tooltip')).toBeFalsy();
    });
  });

  describe('gestures', () => {
    beforeEach(() => {
      setPoints(TWO_POINTS);
    });

    const canvas = () => fixture.nativeElement.querySelector('canvas') as HTMLCanvasElement;

    it('pans on a single-pointer drag', () => {
      // jsdom does not implement pointer capture.
      canvas().setPointerCapture = vi.fn();
      canvas().dispatchEvent(
        new PointerEvent('pointerdown', { pointerId: 1, clientX: 0, clientY: 0, bubbles: true }),
      );
      canvas().dispatchEvent(
        new PointerEvent('pointermove', { pointerId: 1, clientX: 10, clientY: 5, bubbles: true }),
      );
      canvas().dispatchEvent(
        new PointerEvent('pointerup', { pointerId: 1, clientX: 10, clientY: 5, bubbles: true }),
      );
      fixture.detectChanges();

      expect(() => canvas().dispatchEvent(new PointerEvent('pointercancel', { pointerId: 1 })))
        .not.toThrow();
    });

    it('zooms toward the cursor on wheel', () => {
      const viewport = (
        fixture.componentInstance as unknown as {
          viewport: { transform: () => { scale: number } };
        }
      ).viewport;
      const before = viewport.transform().scale;

      canvas().dispatchEvent(
        new WheelEvent('wheel', { deltaY: -100, clientX: 5, clientY: 5, bubbles: true, cancelable: true }),
      );
      fixture.detectChanges();

      expect(viewport.transform().scale).not.toBe(before);
    });
  });

  describe('canvas drawing', () => {
    let ctx: ReturnType<typeof fakeCanvasContext>;

    beforeEach(() => {
      (globalThis as unknown as { ResizeObserver: typeof ResizeObserver }).ResizeObserver =
        FakeResizeObserver as unknown as typeof ResizeObserver;
      ctx = fakeCanvasContext();
      vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(
        ctx as unknown as CanvasRenderingContext2D,
      );
    });

    afterEach(() => vi.restoreAllMocks());

    const settle = async () => {
      fixture.detectChanges();
      await fixture.whenStable();
      fixture.detectChanges();
    };

    it('draws a single speed band when every point has the same speed', async () => {
      setPoints([
        tracePoint({ lon: 0, lat: 0, speedKmh: 150 }),
        tracePoint({ lon: 0.01, lat: 0, speedKmh: 150 }),
      ]);
      await settle();

      expect(ctx.stroke).toHaveBeenCalled();
    });

    it('draws multiple speed bands when speed varies, including null-speed points', async () => {
      setPoints([
        tracePoint({ lon: 0, lat: 0, speedKmh: 60 }),
        tracePoint({ lon: 0.003, lat: 0, speedKmh: null }),
        tracePoint({ lon: 0.006, lat: 0, speedKmh: 200 }),
        tracePoint({ lon: 0.01, lat: 0, speedKmh: 90 }),
      ]);
      await settle();

      expect(ctx.stroke.mock.calls.length).toBeGreaterThan(1);
    });

    it('draws the ghost lap dashed when a comparison lap is set', async () => {
      fixture.componentRef.setInput('ghostPoints', [
        tracePoint({ lon: 0, lat: 0.001 }),
        tracePoint({ lon: 0.01, lat: 0.001 }),
      ]);
      setPoints(TWO_POINTS);
      await settle();

      expect(ctx.setLineDash).toHaveBeenCalledWith([]);
      // A real dash pattern was set at some point, not just the resets either side.
      expect(ctx.setLineDash.mock.calls.some((call) => call[0].length > 0)).toBe(true);
    });

    it('draws the ghost lap solid and undashed when its appearance is optimal', async () => {
      fixture.componentRef.setInput('ghostAppearance', 'optimal');
      fixture.componentRef.setInput('ghostPoints', [
        tracePoint({ lon: 0, lat: 0.001 }),
        tracePoint({ lon: 0.01, lat: 0.001 }),
      ]);
      setPoints(TWO_POINTS);
      await settle();

      // Never asked for a dash pattern — every call is the reset to [].
      expect(ctx.setLineDash.mock.calls.every((call) => call[0].length === 0)).toBe(true);
      expect(ctx.strokeStyleHistory).toContain('#ff2d55');
    });

    it('draws braking-point markers', async () => {
      fixture.componentRef.setInput('brakingPoints', [
        { distM: 50, lat: 0, lon: 0.005, entrySpeedKmh: 80, peakDecelG: 1.2 } satisfies BrakingPoint,
      ]);
      setPoints(TWO_POINTS);
      await settle();

      expect(ctx.arc).toHaveBeenCalled();
      expect(ctx.fill).toHaveBeenCalled();
    });

    it('draws the circuit outline and corner markers from the track map', async () => {
      const trackMap: TrackMapGeoJson = {
        type: 'FeatureCollection',
        features: [
          {
            type: 'Feature',
            properties: { role: 'circuit', lengthM: 5000, widthM: 12 },
            geometry: {
              type: 'LineString',
              coordinates: [
                [0, 0],
                [0.01, 0],
                [0.01, 0.001],
                [0, 0],
              ],
            },
          },
          {
            type: 'Feature',
            properties: { role: 'corner', name: 'Turn 1' },
            geometry: { type: 'LineString', coordinates: [[0.005, 0]] },
          },
        ],
      };

      fixture.componentRef.setInput('trackMap', trackMap);
      setPoints(TWO_POINTS);
      await settle();

      // Circuit + band strokes, at minimum; corner markers get filled/stroked too.
      expect(ctx.stroke.mock.calls.length).toBeGreaterThan(1);
      expect(ctx.arc).toHaveBeenCalled();
    });
  });
});
