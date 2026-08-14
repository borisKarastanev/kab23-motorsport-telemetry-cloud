import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { signal } from '@angular/core';

import { SessionAnalysis } from './session-analysis';
import { LapAnalysisService } from '../../core/services/lap-analysis.service';
import { TrackMapService } from '../../core/services/track-map.service';
import { AnalysisSkipReason, Lap, LapCompare, LapTrace } from '../../core/models/analysis.model';
import { ChartSeries } from '../../core/charts/line-chart';

function makeLap(overrides: Partial<Lap> = {}): Lap {
  return {
    id: `lap-${overrides.lapNumber ?? 1}`,
    sessionId: 'session-1',
    lapNumber: 1,
    startedAt: '2026-08-14T09:00:00Z',
    endedAt: '2026-08-14T09:01:32Z',
    lapMs: 92000,
    distanceM: 2100,
    maxSpeedKmh: 210,
    minSpeedKmh: 40,
    sectorMs: [30000, 31000, 31000],
    brakingPoints: [],
    isBest: false,
    ...overrides,
  };
}

function makeAnalysisStub() {
  return {
    laps: signal<Lap[]>([]),
    analyzedAt: signal<string | null>(null),
    reason: signal<AnalysisSkipReason | null>(null),
    loading: signal(false),
    error: signal<unknown>(null),
    bestLap: signal<number | null>(null),
    activeLap: signal<number | null>(null),
    referenceLap: signal<number | null>(null),
    activeLapRow: signal<Lap | undefined>(undefined),
    activeTrace: signal<LapTrace | null>(null),
    referenceTrace: signal<LapTrace | null>(null),
    compare: signal<LapCompare | null>(null),
    traceLoading: signal(false),
    open: vi.fn(),
    select: vi.fn(),
    toggleCompare: vi.fn(),
    recompute: vi.fn().mockResolvedValue(undefined),
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

type AnalysisStub = ReturnType<typeof makeAnalysisStub>;
type TrackMapStub = ReturnType<typeof makeTrackMapStub>;

describe('SessionAnalysis', () => {
  let fixture: ComponentFixture<SessionAnalysis>;
  let analysis: AnalysisStub;
  let trackMap: TrackMapStub;

  const create = (id = 'session-1') => {
    fixture = TestBed.createComponent(SessionAnalysis);
    fixture.componentRef.setInput('id', id);
    fixture.detectChanges();
  };

  const protectedOf = <T>(fx: ComponentFixture<SessionAnalysis> = fixture) =>
    fx.componentInstance as unknown as T;

  beforeEach(() => {
    analysis = makeAnalysisStub();
    trackMap = makeTrackMapStub();

    TestBed.configureTestingModule({
      imports: [SessionAnalysis],
      providers: [provideRouter([]), { provide: TrackMapService, useValue: trackMap }],
    });

    // LapAnalysisService is provided on the component itself (one store per
    // view), so it has to be overridden on the component's own provider list
    // rather than the module's.
    TestBed.overrideComponent(SessionAnalysis, {
      set: { providers: [{ provide: LapAnalysisService, useValue: analysis }] },
    });
  });

  it('opens the analysis store and the track map for the routed session id', () => {
    create('session-42');

    expect(analysis.open).toHaveBeenCalledWith('session-42');
    expect(trackMap.openForSession).toHaveBeenCalledWith('session-42');
  });

  it('idles the track map on destroy so it does not keep polling for a closed view', () => {
    create('session-42');
    trackMap.openForSession.mockClear();

    fixture.destroy();

    expect(trackMap.openForSession).toHaveBeenCalledWith(null);
  });

  it('shows a loading message while the analysis is loading', () => {
    analysis.loading.set(true);
    create();

    expect(fixture.nativeElement.textContent).toContain('Deriving laps…');
  });

  it('shows an error message when the session failed to load', () => {
    analysis.error.set(new Error('nope'));
    create();

    expect(fixture.nativeElement.textContent).toContain('Could not load this session.');
  });

  describe('empty state', () => {
    it('explains a live session in driver terms', () => {
      analysis.reason.set('session-live');
      create();

      expect(fixture.nativeElement.textContent).toContain('No laps');
      expect(fixture.nativeElement.textContent).toContain(
        'This session is still running. Laps are derived once it closes.',
      );
    });

    it('adds a note that no manual fix is needed for a missed start/finish crossing', () => {
      analysis.reason.set('no-crossings');
      create();

      expect(fixture.nativeElement.textContent).toContain(
        'A corrected start/finish line is picked up on the next load',
      );
    });

    it('is not shown once laps exist, even with a reason set', () => {
      analysis.reason.set('no-crossings');
      analysis.laps.set([makeLap({ isBest: true })]);
      analysis.activeLapRow.set(makeLap({ isBest: true }));
      create();

      expect(fixture.nativeElement.textContent).not.toContain('No laps');
    });
  });

  describe('headline', () => {
    it('shows the active lap time and a fastest pill for the best lap', () => {
      const best = makeLap({ lapNumber: 1, lapMs: 92184, isBest: true });
      analysis.laps.set([best]);
      analysis.activeLap.set(1);
      analysis.activeLapRow.set(best);
      create();

      expect(fixture.nativeElement.textContent).toContain('1:32.184');
      expect(fixture.nativeElement.querySelector('.pill.connected')?.textContent).toContain(
        'Fastest',
      );
    });

    it('shows the delta against the reference lap when one is set', () => {
      const active = makeLap({ lapNumber: 2, lapMs: 92500, isBest: false });
      const reference = makeLap({ lapNumber: 1, lapMs: 92000, isBest: true });
      analysis.laps.set([reference, active]);
      analysis.activeLap.set(2);
      analysis.referenceLap.set(1);
      analysis.activeLapRow.set(active);
      create();

      expect(fixture.nativeElement.textContent).toContain('+0.500 vs lap 1');
    });
  });

  it('shows the "Analyzed" pill only once the session has been analysed', () => {
    const lap = makeLap({ isBest: true });
    analysis.laps.set([lap]);
    analysis.activeLapRow.set(lap);
    create();
    expect(fixture.nativeElement.querySelector('.pill')?.textContent?.trim()).toBe(
      'Not analyzed',
    );

    analysis.analyzedAt.set('2026-08-14T09:00:00Z');
    fixture.detectChanges();
    expect(fixture.nativeElement.textContent).toContain('Analyzed');
  });

  it('shows the track name once TrackMapService resolves it', () => {
    const lap = makeLap({ isBest: true });
    analysis.laps.set([lap]);
    analysis.activeLapRow.set(lap);
    trackMap.trackName.set('Serres Automotive Park');
    create();

    expect(fixture.nativeElement.textContent).toContain('Serres Automotive Park');
  });

  it('forwards a lap-table selection to the analysis store', () => {
    const lap1 = makeLap({ lapNumber: 1, isBest: true });
    const lap2 = makeLap({ lapNumber: 2 });
    analysis.laps.set([lap1, lap2]);
    analysis.activeLap.set(1);
    analysis.activeLapRow.set(lap1);
    create();

    const pickButtons = fixture.nativeElement.querySelectorAll('app-lap-table .pick');
    (pickButtons[1] as HTMLButtonElement).click();

    expect(analysis.select).toHaveBeenCalledWith(2);
  });

  it('forwards a lap-table compare toggle to the analysis store', () => {
    const lap1 = makeLap({ lapNumber: 1, isBest: true });
    const lap2 = makeLap({ lapNumber: 2 });
    analysis.laps.set([lap1, lap2]);
    analysis.activeLap.set(1);
    analysis.activeLapRow.set(lap1);
    create();

    const vsButtons = fixture.nativeElement.querySelectorAll('app-lap-table .vs');
    (vsButtons[1] as HTMLButtonElement).click();

    expect(analysis.toggleCompare).toHaveBeenCalledWith(2);
  });

  describe('chart series', () => {
    beforeEach(() => {
      const lap = makeLap({ isBest: true });
      analysis.laps.set([lap]);
      analysis.activeLap.set(1);
      analysis.activeLapRow.set(lap);
    });

    it('builds the active-only series when there is no reference trace', () => {
      analysis.activeTrace.set({
        lapNumber: 1,
        lapMs: 92000,
        distanceM: 2100,
        points: [
          {
            distM: 0,
            elapsedMs: 0,
            lat: 0,
            lon: 0,
            speedKmh: 100,
            rpm: 5000,
            coolantC: 90,
            oilC: 95,
            gLat: 0,
            gLon: 0,
          },
        ],
      });
      create();

      const speedSeries = protectedOf<{ speedSeries: () => ChartSeries[] }>().speedSeries();
      expect(speedSeries).toHaveLength(1);
      expect(speedSeries[0].points).toEqual([{ x: 0, y: 100 }]);
    });

    it('appends a muted reference series once one is available', () => {
      const point = {
        distM: 0,
        elapsedMs: 0,
        lat: 0,
        lon: 0,
        speedKmh: 100,
        rpm: 5000,
        coolantC: 90,
        oilC: 95,
        gLat: 0,
        gLon: 0,
      };
      analysis.activeTrace.set({ lapNumber: 1, lapMs: 92000, distanceM: 2100, points: [point] });
      analysis.referenceTrace.set({
        lapNumber: 2,
        lapMs: 90000,
        distanceM: 2100,
        points: [{ ...point, speedKmh: 120 }],
      });
      analysis.referenceLap.set(2);
      create();

      const speedSeries = protectedOf<{ speedSeries: () => ChartSeries[] }>().speedSeries();
      expect(speedSeries).toHaveLength(2);
      expect(speedSeries[1].muted).toBe(true);
      expect(speedSeries[1].points).toEqual([{ x: 0, y: 120 }]);
    });

    it('builds coolant and oil series from the active lap only', () => {
      analysis.activeTrace.set({
        lapNumber: 1,
        lapMs: 92000,
        distanceM: 2100,
        points: [
          {
            distM: 10,
            elapsedMs: 0,
            lat: 0,
            lon: 0,
            speedKmh: 100,
            rpm: 5000,
            coolantC: 91,
            oilC: 96,
            gLat: 0,
            gLon: 0,
          },
        ],
      });
      create();

      const tempSeries = protectedOf<{ tempSeries: () => ChartSeries[] }>().tempSeries();
      expect(tempSeries.map((s) => s.label)).toEqual(['Coolant', 'Oil']);
      expect(tempSeries[0].points).toEqual([{ x: 10, y: 91 }]);
      expect(tempSeries[1].points).toEqual([{ x: 10, y: 96 }]);
    });

    it('is empty with no compare set, and built from it once one is', () => {
      create();
      let deltaSeries = protectedOf<{ deltaSeries: () => ChartSeries[] }>().deltaSeries();
      expect(deltaSeries).toEqual([]);

      analysis.compare.set({
        lapA: 1,
        lapB: 2,
        distanceM: 2100,
        points: [
          {
            distM: 5,
            elapsedAMs: 0,
            elapsedBMs: 0,
            deltaMs: 184,
            speedAKmh: 100,
            speedBKmh: 98,
          },
        ],
      });
      fixture.detectChanges();

      deltaSeries = protectedOf<{ deltaSeries: () => ChartSeries[] }>().deltaSeries();
      expect(deltaSeries).toHaveLength(1);
      expect(deltaSeries[0].label).toBe('Lap 2 vs lap 1');
      expect(deltaSeries[0].points).toEqual([{ x: 5, y: 0.184 }]);
    });
  });

  describe('recompute', () => {
    beforeEach(() => {
      const lap = makeLap({ isBest: true });
      analysis.laps.set([lap]);
      analysis.activeLapRow.set(lap);
    });

    it('calls through to the analysis store and clears any previous error on success', async () => {
      create();

      const button = fixture.nativeElement.querySelector(
        '.topbar button.ghost-button',
      ) as HTMLButtonElement;
      button.click();
      await fixture.whenStable();

      expect(analysis.recompute).toHaveBeenCalled();
      expect(button.disabled).toBe(false);
    });

    it('shows a generic error message when the recompute request fails', async () => {
      analysis.recompute.mockRejectedValueOnce(new Error('server said no'));
      create();

      const button = fixture.nativeElement.querySelector(
        '.topbar button.ghost-button',
      ) as HTMLButtonElement;
      button.click();
      await fixture.whenStable();
      fixture.detectChanges();

      // Deliberately not the thrown error's own message — see the component's
      // own comment on why nothing past "it failed" is shown.
      expect(fixture.nativeElement.textContent).toContain('Could not re-run the analysis.');
    });
  });
});
