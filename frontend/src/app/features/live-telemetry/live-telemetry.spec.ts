import { ComponentFixture, TestBed } from '@angular/core/testing';
import { By } from '@angular/platform-browser';
import { Router, provideRouter } from '@angular/router';
import { signal } from '@angular/core';

import { LiveTelemetry } from './live-telemetry';
import { CarsService } from '../../core/services/cars.service';
import { LiveTelemetryService, ChannelPoint } from '../../core/services/live-telemetry.service';
import { TrackMapService } from '../../core/services/track-map.service';
import { Car, LiveFrame, LiveState, TracePoint } from '../../core/models/live-telemetry.model';
import { Gauges } from './gauges';
import { TrackTrace } from './track-trace';
import { ChartSeries } from '../../core/charts/line-chart';

const CARS: Car[] = [
  { id: 'car-1', name: 'Car One', make: 'Radical', model: 'SR3', deviceId: 'dev-1' },
  { id: 'car-2', name: 'Car Two', deviceId: 'dev-2' },
];

function makeLiveStub() {
  return {
    latest: signal<LiveFrame | null>(null),
    trace: signal<TracePoint[]>([]),
    channels: signal<ChannelPoint[]>([]),
    state: signal<LiveState>('idle'),
    error: signal<string | null>(null),
    sessionId: signal<string | null>(null),
    sessionActive: signal(false),
    position: signal<TracePoint | null>(null),
    latencyMs: signal<number | null>(null),
    connect: vi.fn(),
    disconnect: vi.fn(),
  };
}

function makeTrackMapStub() {
  return {
    trackName: signal<string | null>(null),
    attribution: signal<string | null>(null),
    map: signal(null),
    status: signal<string | null>(null),
    open: vi.fn(),
    openForSession: vi.fn(),
  };
}

type LiveStub = ReturnType<typeof makeLiveStub>;
type TrackMapStub = ReturnType<typeof makeTrackMapStub>;

describe('LiveTelemetry', () => {
  let fixture: ComponentFixture<LiveTelemetry>;
  let live: LiveStub;
  let trackMap: TrackMapStub;
  let carsValue: ReturnType<typeof signal<Car[]>>;
  let carsLoading: ReturnType<typeof signal<boolean>>;

  const create = (carId?: string) => {
    fixture = TestBed.createComponent(LiveTelemetry);
    if (carId !== undefined) {
      fixture.componentRef.setInput('carId', carId);
    }
    fixture.detectChanges();
  };

  const protectedOf = <T>() => fixture.componentInstance as unknown as T;

  beforeEach(() => {
    live = makeLiveStub();
    trackMap = makeTrackMapStub();
    carsValue = signal<Car[]>(CARS);
    carsLoading = signal(false);

    TestBed.configureTestingModule({
      imports: [LiveTelemetry],
      providers: [
        provideRouter([]),
        {
          provide: CarsService,
          useValue: { value: carsValue.asReadonly(), loading: carsLoading.asReadonly() },
        },
        { provide: TrackMapService, useValue: trackMap },
      ],
    });

    // LiveTelemetryService is provided on the component itself (one socket per
    // view), so it has to be overridden on the component's own provider list.
    TestBed.overrideComponent(LiveTelemetry, {
      set: { providers: [{ provide: LiveTelemetryService, useValue: live }] },
    });
  });

  describe('car picker', () => {
    it('shows a loading message while cars are loading', () => {
      carsLoading.set(true);
      create();

      expect(fixture.nativeElement.textContent).toContain('Loading…');
    });

    it('shows an empty state with no cars', () => {
      carsValue.set([]);
      create();

      expect(fixture.nativeElement.textContent).toContain(
        'No cars yet. Register one to start streaming.',
      );
    });

    it('lists every car, with make/model shown only when present', () => {
      create();

      const buttons = fixture.nativeElement.querySelectorAll('.picker button');
      expect(buttons).toHaveLength(2);
      expect(buttons[0].textContent).toContain('Car One');
      expect(buttons[0].textContent).toContain('Radical SR3');
      expect(buttons[1].textContent).toContain('Car Two');
      expect(buttons[1].querySelector('.muted')).toBeFalsy();
    });

    it('marks the routed car active in the picker', () => {
      create('car-2');

      const buttons = fixture.nativeElement.querySelectorAll('.picker button');
      expect(buttons[0].classList.contains('active')).toBe(false);
      expect(buttons[1].classList.contains('active')).toBe(true);
    });

    it('navigates to the clicked car', () => {
      create();
      const navigateSpy = vi.spyOn(TestBed.inject(Router), 'navigate').mockResolvedValue(true);

      (fixture.nativeElement.querySelectorAll('.picker button')[1] as HTMLButtonElement).click();

      expect(navigateSpy).toHaveBeenCalledWith(['/live', 'car-2']);
    });
  });

  it('shows a prompt instead of the panel when no car is selected', () => {
    create();

    expect(fixture.nativeElement.textContent).toContain('Select a car to watch it live.');
    expect(fixture.nativeElement.querySelector('app-gauges')).toBeFalsy();
  });

  describe('socket lifecycle', () => {
    it('connects the live socket to the routed car', () => {
      create('car-1');

      expect(live.connect).toHaveBeenCalledWith('car-1');
    });

    it('disconnects when routed to no car', () => {
      create(undefined);

      expect(live.disconnect).toHaveBeenCalled();
      expect(live.connect).not.toHaveBeenCalled();
    });

    it('reconnects when the routed car changes', () => {
      create('car-1');
      live.connect.mockClear();

      fixture.componentRef.setInput('carId', 'car-2');
      fixture.detectChanges();

      expect(live.connect).toHaveBeenCalledWith('car-2');
    });

    it('follows the live session id into TrackMapService', () => {
      create('car-1');

      live.sessionId.set('session-9');
      fixture.detectChanges();

      expect(trackMap.openForSession).toHaveBeenCalledWith('session-9');
    });

    it('tears down the socket and the track map on destroy', () => {
      create('car-1');
      trackMap.openForSession.mockClear();

      fixture.destroy();

      expect(live.disconnect).toHaveBeenCalled();
      expect(trackMap.openForSession).toHaveBeenCalledWith(null);
    });
  });

  describe('selected-car panel', () => {
    beforeEach(() => create('car-1'));

    it('shows the car name and the track name once resolved', () => {
      trackMap.trackName.set('Serres Automotive Park');
      fixture.detectChanges();

      expect(fixture.nativeElement.querySelector('h1')?.textContent).toBe('Car One');
      expect(fixture.nativeElement.textContent).toContain('Serres Automotive Park');
    });

    it('shows "On track" only while a session is active', () => {
      expect(fixture.nativeElement.textContent).toContain('Between sessions');

      live.sessionActive.set(true);
      fixture.detectChanges();

      expect(fixture.nativeElement.querySelector('.pill.connected')?.textContent).toContain(
        'On track',
      );
    });

    it('shows a live-feed error when one is set', () => {
      live.error.set('Could not reach the live feed');
      fixture.detectChanges();

      expect(fixture.nativeElement.querySelector('.error')?.textContent).toContain(
        'Could not reach the live feed',
      );
    });

    it('passes the latest frame through to the gauges', () => {
      live.latest.set({
        v: 1,
        sessionId: 's1',
        carId: 'car-1',
        t: 0,
        pt: 0,
        seq: 1,
        speed: 180,
      });
      fixture.detectChanges();

      const gauges = fixture.debugElement.query(By.directive(Gauges)).componentInstance as Gauges;
      expect(gauges.frame()?.speed).toBe(180);
    });

    it('passes trace, position, track map and reset key through to the track trace', () => {
      const points: TracePoint[] = [{ lat: 41.07, lon: 23.5 }];
      live.trace.set(points);
      live.position.set(points[0]);
      fixture.detectChanges();

      const trace = fixture.debugElement.query(By.directive(TrackTrace))
        .componentInstance as TrackTrace;
      expect(trace.points()).toEqual(points);
      expect(trace.position()).toEqual(points[0]);
      expect(trace.resetKey()).toBe('car-1');
    });

    it('shows delivery latency only once it is measurable, including zero', () => {
      expect(fixture.nativeElement.textContent).not.toContain('delivery ~');

      live.latencyMs.set(0);
      fixture.detectChanges();
      expect(fixture.nativeElement.textContent).toContain('delivery ~0 ms');
    });

    it('shows the current trace point count', () => {
      live.trace.set([
        { lat: 1, lon: 1 },
        { lat: 2, lon: 2 },
      ]);
      fixture.detectChanges();

      expect(fixture.nativeElement.textContent).toContain('2 points');
    });

    it('shows the track map attribution once known', () => {
      trackMap.attribution.set('Map data © OpenStreetMap contributors, ODbL 1.0');
      fixture.detectChanges();

      expect(fixture.nativeElement.textContent).toContain('Map data © OpenStreetMap contributors');
    });
  });

  describe('chart series', () => {
    const point = (t: number, overrides: Partial<ChannelPoint> = {}): ChannelPoint => ({
      t,
      speed: 100,
      rpm: 5000,
      coolant: 90,
      oil: 95,
      ...overrides,
    });

    beforeEach(() => create('car-1'));

    it('passes session-elapsed x straight through, without re-zeroing it', () => {
      // The chart scales to its data's own [min, max], so a rolling window
      // whose oldest point is two minutes into the session still fills the
      // plot. Re-zeroing here as well would be a subtraction the chart
      // immediately undoes — and it would leave each series free to disagree
      // with the others about where x starts.
      live.channels.set([point(120, { speed: 100 }), point(121, { speed: 110 })]);
      fixture.detectChanges();

      const speedSeries = protectedOf<{ speedSeries: () => ChartSeries[] }>().speedSeries();
      expect(speedSeries[0].points).toEqual([
        { x: 120, y: 100 },
        { x: 121, y: 110 },
      ]);
    });

    it('builds RPM the same way, from the same channel window', () => {
      live.channels.set([point(10, { rpm: 4000 }), point(11, { rpm: 4500 })]);
      fixture.detectChanges();

      const rpmSeries = protectedOf<{ rpmSeries: () => ChartSeries[] }>().rpmSeries();
      expect(rpmSeries[0].points).toEqual([
        { x: 10, y: 4000 },
        { x: 11, y: 4500 },
      ]);
    });

    it('builds coolant and oil as two series from the same window', () => {
      live.channels.set([point(5, { coolant: 91, oil: 96 })]);
      fixture.detectChanges();

      const tempSeries = protectedOf<{ tempSeries: () => ChartSeries[] }>().tempSeries();
      expect(tempSeries.map((s) => s.label)).toEqual(['Coolant', 'Oil']);
      expect(tempSeries[0].points).toEqual([{ x: 5, y: 91 }]);
      expect(tempSeries[1].points).toEqual([{ x: 5, y: 96 }]);
    });

    it('is empty with no channel history yet', () => {
      const speedSeries = protectedOf<{ speedSeries: () => ChartSeries[] }>().speedSeries();
      expect(speedSeries[0].points).toEqual([]);
    });
  });
});
