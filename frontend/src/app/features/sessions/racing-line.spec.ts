import { ComponentFixture, TestBed } from '@angular/core/testing';

import { RacingLine } from './racing-line';
import { BrakingPoint, LapTracePoint } from '../../core/models/analysis.model';

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
});
