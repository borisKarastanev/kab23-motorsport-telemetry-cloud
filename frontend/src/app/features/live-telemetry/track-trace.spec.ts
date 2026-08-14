import { ComponentFixture, TestBed } from '@angular/core/testing';

import { TrackTrace } from './track-trace';
import { TracePoint } from '../../core/models/live-telemetry.model';
import { TrackMapGeoJson } from '../../core/models/track-map.model';

/**
 * jsdom implements neither `ResizeObserver` nor `HTMLCanvasElement#getContext`.
 * Without both, `viewport.containerSize` never leaves `{0,0}` and the
 * `afterRenderEffect`'s draw guard bails before `drawScene` ever runs. See
 * `racing-line.spec.ts`, which uses the same stub for its twin canvas view.
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
  return {
    beginPath: vi.fn(),
    moveTo: vi.fn(),
    lineTo: vi.fn(),
    stroke: vi.fn(),
    arc: vi.fn(),
    fill: vi.fn(),
    setLineDash: vi.fn(),
    clearRect: vi.fn(),
    setTransform: vi.fn(),
    strokeStyle: '',
    fillStyle: '',
    lineWidth: 0,
    lineCap: '',
    lineJoin: '',
    globalAlpha: 1,
  };
}

const CIRCUIT_MAP: TrackMapGeoJson = {
  type: 'FeatureCollection',
  features: [
    {
      type: 'Feature',
      properties: { role: 'circuit', lengthM: 2100, widthM: 10 },
      geometry: {
        type: 'LineString',
        coordinates: [
          [23.5, 41.07],
          [23.501, 41.071],
          [23.5, 41.07],
        ],
      },
    },
  ],
};

describe('TrackTrace', () => {
  let fixture: ComponentFixture<TrackTrace>;

  const set = (points: TracePoint[], trackMap: TrackMapGeoJson | null = null) => {
    fixture.componentRef.setInput('points', points);
    fixture.componentRef.setInput('trackMap', trackMap);
    fixture.detectChanges();
  };

  beforeEach(() => {
    TestBed.configureTestingModule({ imports: [TrackTrace] });
    fixture = TestBed.createComponent(TrackTrace);
  });

  it('shows a waiting message with no trace and no track map', () => {
    set([]);

    expect(fixture.nativeElement.querySelector('.empty')?.textContent).toContain(
      'Waiting for a GPS fix…',
    );
    expect(fixture.nativeElement.querySelector('.reset')).toBeFalsy();
    // The canvas itself is unconditional, so pan/zoom is still wired once a
    // fix does arrive without the component having to re-render it in.
    expect(fixture.nativeElement.querySelector('canvas')).toBeTruthy();
  });

  it('renders the canvas and reset control once a GPS fix has produced a point', () => {
    set([{ lat: 41.07, lon: 23.5 }]);

    expect(fixture.nativeElement.querySelector('.empty')).toBeFalsy();
    expect(fixture.nativeElement.querySelector('.reset')).toBeTruthy();
  });

  it('renders the canvas once a circuit is known, even before any GPS fix', () => {
    // A manager opening the view for a car already on track should see the
    // circuit immediately, not wait for the first frame with a lat/lon.
    set([], CIRCUIT_MAP);

    expect(fixture.nativeElement.querySelector('.empty')).toBeFalsy();
    expect(fixture.nativeElement.querySelector('.reset')).toBeTruthy();
  });

  it('resets the view when "Reset view" is clicked', () => {
    set([{ lat: 41.07, lon: 23.5 }]);

    const resetSpy = vi.spyOn(
      (fixture.componentInstance as unknown as { viewport: { resetView: () => void } }).viewport,
      'resetView',
    );
    (fixture.nativeElement.querySelector('.reset') as HTMLButtonElement).click();

    expect(resetSpy).toHaveBeenCalled();
  });

  describe('gestures', () => {
    beforeEach(() => set([{ lat: 41.07, lon: 23.5 }]));

    const canvas = () => fixture.nativeElement.querySelector('canvas') as HTMLCanvasElement;

    it('pans on a single-pointer drag', () => {
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

    it('draws just the marker for a single-point trace with no circuit', async () => {
      set([{ lat: 41.07, lon: 23.5 }]);
      fixture.componentRef.setInput('position', { lat: 41.07, lon: 23.5 });
      await settle();

      expect(ctx.arc).toHaveBeenCalled();
      expect(ctx.fill).toHaveBeenCalled();
    });

    it('draws the trace line once there are at least two points', async () => {
      set([
        { lat: 41.07, lon: 23.5 },
        { lat: 41.071, lon: 23.501 },
      ]);
      await settle();

      expect(ctx.stroke).toHaveBeenCalled();
    });

    it('draws the circuit outline when a track map is known', async () => {
      set([{ lat: 41.07, lon: 23.5 }], CIRCUIT_MAP);
      await settle();

      expect(ctx.stroke).toHaveBeenCalled();
      expect(ctx.setTransform).toHaveBeenCalled();
    });

    it('fits to the circuit, not the moving trace, once a track map is known', async () => {
      set(
        [
          { lat: 41.07, lon: 23.5 },
          { lat: 41.071, lon: 23.501 },
        ],
        CIRCUIT_MAP,
      );
      await settle();

      const world = (
        fixture.componentInstance as unknown as {
          world: () => { minSpan: number | undefined } | null;
        }
      ).world();

      // minSpan only applies to the no-circuit fit path — see the class docblock.
      expect(world?.minSpan).toBeUndefined();
    });
  });
});
