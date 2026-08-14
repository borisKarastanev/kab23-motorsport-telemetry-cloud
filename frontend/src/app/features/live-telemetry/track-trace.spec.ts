import { ComponentFixture, TestBed } from '@angular/core/testing';

import { TrackTrace } from './track-trace';
import { TracePoint } from '../../core/models/live-telemetry.model';
import { TrackMapGeoJson } from '../../core/models/track-map.model';

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
});
