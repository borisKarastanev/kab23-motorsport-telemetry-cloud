import { TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';

import { LapAnalysisService } from './lap-analysis.service';

/**
 * Every public read here is guarded with `hasValue()`, and this is the spec
 * that keeps it that way.
 *
 * `httpResource.value()` throws `ResourceValueError` in the error state —
 * `defaultValue` does not cover it. `session-analysis.html` binds
 * `analysis.analyzedAt()` in its topbar, *above* the `@else if
 * (analysis.error())` branch that renders failures, so an unguarded read threw
 * during change detection and took down the whole analysis view instead of
 * showing the error state that already existed for the case. All three status
 * codes below are states this feature produces normally: 401 once the 24 h
 * JWT expires on a long-open tab, 403 for another team's session, 404 for one
 * that has been deleted.
 */
describe('LapAnalysisService', () => {
  let http: HttpTestingController;
  let service: LapAnalysisService;

  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [provideHttpClient(), provideHttpClientTesting(), LapAnalysisService],
    });

    http = TestBed.inject(HttpTestingController);
    service = TestBed.inject(LapAnalysisService);
  });

  afterEach(() => http.verify());

  const failAllWith = async (status: number, statusText: string) => {
    TestBed.tick();
    for (const req of http.match(() => true)) {
      req.flush('nope', { status, statusText });
    }
    TestBed.tick();
    await Promise.resolve();
  };

  const failureCases: [string, number, string][] = [
    ['401 after the JWT expires on a long-open tab', 401, 'Unauthorized'],
    ["403 for another team's session", 403, 'Forbidden'],
    ['404 for a deleted session', 404, 'Not Found'],
  ];

  for (const [name, status, statusText] of failureCases) {
    it(`survives a ${name}`, async () => {
      service.open('session-1');
      await failAllWith(status, statusText);

      // Read in the order the template does: `analyzedAt` is the topbar pill,
      // and it is evaluated before anything checks `error()`.
      expect(() => service.analyzedAt()).not.toThrow();
      expect(service.analyzedAt()).toBeNull();
      expect(service.laps()).toEqual([]);
      expect(service.reason()).toBeNull();
      expect(service.activeTrace()).toBeNull();
      expect(service.referenceTrace()).toBeNull();
      expect(service.compare()).toBeNull();
      expect(service.error()).toBeTruthy();
    });
  }

  it('exposes laps and the analysed timestamp on a normal response', async () => {
    service.open('session-1');
    TestBed.tick();

    http
      .match((r) => r.url.endsWith('/laps'))
      .forEach((req) =>
        req.flush({
          analyzedAt: '2026-08-14T09:00:00Z',
          laps: [{ lapNumber: 1, lapTimeMs: 92000, isBest: true }],
        }),
      );
    // The trace requests are this view's other reads; the laps response above
    // is the one under test.
    http.match(() => true).forEach((req) => req.flush({ points: [] }));
    TestBed.tick();
    await Promise.resolve();

    expect(service.analyzedAt()).toBe('2026-08-14T09:00:00Z');
    expect(service.laps()).toHaveLength(1);
    expect(service.bestLap()).toBe(1);
    // A legacy-shaped fixture with neither field — null-safe, not a throw.
    expect(service.optimal()).toBeNull();
    expect(service.sectorScheme()).toBeUndefined();
  });

  it('exposes the optimal lap and sector scheme when the response carries them', async () => {
    service.open('session-1');
    TestBed.tick();

    const optimal = {
      lapMs: 85000,
      distanceM: 2100,
      sectors: [{ sector: 0, lapNumber: 1, sectorMs: 28000 }],
      brakingPoints: [],
      matchesLapNumber: null,
      seams: [],
    };
    http
      .match((r) => r.url.endsWith('/laps'))
      .forEach((req) =>
        req.flush({
          analyzedAt: '2026-08-14T09:00:00Z',
          laps: [{ lapNumber: 1, lapTimeMs: 92000, isBest: true }],
          optimal,
          sectorScheme: 'gates',
        }),
      );
    http.match(() => true).forEach((req) => req.flush({ points: [] }));
    TestBed.tick();
    await Promise.resolve();

    expect(service.optimal()).toEqual(optimal);
    expect(service.sectorScheme()).toBe('gates');
  });

  describe('selection and comparison', () => {
    const OPTIMAL = {
      lapMs: 85000,
      distanceM: 2100,
      sectors: [{ sector: 0, lapNumber: 1, sectorMs: 28000 }],
      brakingPoints: [],
      matchesLapNumber: null,
      seams: [],
    };

    /**
     * Three laps and, unless `withOptimal` says otherwise, an optimal lap —
     * which is what a real three-lap session answers with. Sessions without one
     * are the interesting case for whether an `'optimal'` ref can be held at
     * all, so they are opened deliberately rather than by default.
     */
    const openWithLaps = async ({ withOptimal = true } = {}) => {
      service.open('session-1');
      TestBed.tick();

      http
        .match((r) => r.url.endsWith('/laps'))
        .forEach((req) =>
          req.flush({
            analyzedAt: '2026-08-14T09:00:00Z',
            laps: [
              { lapNumber: 1, lapTimeMs: 92000, isBest: true },
              { lapNumber: 2, lapTimeMs: 93000, isBest: false },
              { lapNumber: 3, lapTimeMs: 91500, isBest: false },
            ],
            ...(withOptimal ? { optimal: OPTIMAL } : {}),
          }),
        );
      http.match(() => true).forEach((req) => req.flush({ points: [] }));
      TestBed.tick();
      await Promise.resolve();
    };

    it('defaults the active lap to the best lap until one is selected', async () => {
      await openWithLaps();

      expect(service.activeLap()).toBe(1);
      expect(service.activeLapRow()?.lapNumber).toBe(1);
      // No explicit comparison yet, and the active lap already is the best.
      expect(service.referenceLap()).toBeNull();
    });

    it('selects a lap and compares it against the best by default', async () => {
      await openWithLaps();

      service.select(3);
      TestBed.tick();
      http.match(() => true).forEach((req) => req.flush({ points: [] }));
      TestBed.tick();
      await Promise.resolve();

      expect(service.activeLap()).toBe(3);
      expect(service.activeLapRow()?.lapNumber).toBe(3);
      // Best lap (1) is not the one selected, so it becomes the reference.
      expect(service.referenceLap()).toBe(1);
    });

    it('clears an explicit comparison when selecting the lap it was compared against', async () => {
      await openWithLaps();

      service.toggleCompare(2);
      expect(service.referenceLap()).toBe(2);

      service.select(2);

      // The explicit comparison is gone, so this falls back to the best lap (1).
      expect(service.referenceLap()).toBe(1);
    });

    it('toggles a comparison off when the same lap is chosen again', async () => {
      await openWithLaps();

      service.toggleCompare(3);
      expect(service.referenceLap()).toBe(3);

      service.toggleCompare(3);
      // Falls back to the best lap, which is also the (unchanged) active lap —
      // comparing it to itself is not a comparison.
      expect(service.referenceLap()).toBeNull();
    });

    it('reports no reference when the explicit comparison equals the active lap', async () => {
      await openWithLaps();

      // Lap 1 is already the active (best) lap — comparing it to itself is not a comparison.
      service.toggleCompare(1);

      expect(service.referenceLap()).toBeNull();
    });

    it('is a no-op re-opening the same session', async () => {
      await openWithLaps();
      service.select(3);

      service.open('session-1');

      // The selection survives — a same-session "open" must not reset it.
      expect(service.activeLap()).toBe(3);
    });

    it('resets the selection when opening a different session', async () => {
      await openWithLaps();
      service.select(3);
      service.toggleCompare(2);

      service.open('session-2');
      TestBed.tick();
      http.match(() => true).forEach((req) => req.flush({ points: [] }));
      TestBed.tick();
      await Promise.resolve();

      expect(service.activeLap()).toBeNull();
      expect(service.referenceLap()).toBeNull();
    });

    it('selectRef("optimal") requests the optimal trace, not a numbered lap trace', async () => {
      await openWithLaps();

      service.selectRef('optimal');
      TestBed.tick();

      const optimalReq = http.expectOne((r) => r.url.endsWith('/optimal/trace'));
      expect(service.activeLap()).toBe('optimal');
      optimalReq.flush({ lapNumber: 'optimal', lapMs: 85000, distanceM: 2100, points: [] });
      http.match(() => true).forEach((req) => req.flush({ points: [] }));
      TestBed.tick();
      await Promise.resolve();
    });

    it('setCompare("optimal") requests ?laps=<active>,optimal from compare', async () => {
      await openWithLaps();

      service.setCompare('optimal');
      TestBed.tick();

      // Active lap is 1 (the default best), so the pair is 1,optimal.
      const compareReq = http.expectOne((r) => r.url.includes('/compare'));
      expect(compareReq.request.params.get('laps')).toBe('1,optimal');
      compareReq.flush({ lapA: 1, lapB: 'optimal', distanceM: 2100, points: [] });
      http.match(() => true).forEach((req) => req.flush({ points: [] }));
      TestBed.tick();
      await Promise.resolve();

      expect(service.referenceLap()).toBe('optimal');
    });

    it('selectRef clears an explicit comparison against the newly active ref', async () => {
      await openWithLaps();

      service.setCompare('optimal');
      TestBed.tick();
      http.match(() => true).forEach((req) => req.flush({ points: [] }));
      TestBed.tick();
      await Promise.resolve();
      expect(service.referenceLap()).toBe('optimal');

      service.selectRef('optimal');

      // Comparing the active ref against itself is not a comparison — falls
      // back to the best lap.
      expect(service.referenceLap()).toBe(1);
    });

    it('selectRef ignores a null ref rather than clearing the selection', async () => {
      await openWithLaps();
      service.select(3);

      service.selectRef(null);

      expect(service.activeLap()).toBe(3);
    });

    it('setCompare(null) clears the comparison outright, with no fallback', async () => {
      // The dropdown's "—" is a *choice*, not the absence of one. Treated as
      // absence it was a no-op: the best-lap default put the reference
      // straight back, so the ghost line, the delta chart and the lap table
      // carried on comparing against lap 1 — while the select, bound to a
      // `referenceLap()` that never changed, sat showing "—".
      await openWithLaps();
      service.select(3);
      service.toggleCompare(2);
      expect(service.referenceLap()).toBe(2);

      service.setCompare(null);
      TestBed.tick();
      http.match(() => true).forEach((req) => req.flush({ points: [] }));
      TestBed.tick();
      await Promise.resolve();

      expect(service.referenceLap()).toBeNull();
    });

    it('restores the automatic reference when a lap is picked after "—"', async () => {
      await openWithLaps();
      service.select(3);
      service.setCompare(null);
      expect(service.referenceLap()).toBeNull();

      service.setCompare(2);
      TestBed.tick();
      http.match(() => true).forEach((req) => req.flush({ points: [] }));
      TestBed.tick();
      await Promise.resolve();

      expect(service.referenceLap()).toBe(2);
    });

    it('opening another session forgets an explicit "no comparison"', async () => {
      await openWithLaps();
      service.select(3);
      service.setCompare(null);

      service.open('session-2');
      TestBed.tick();
      http
        .match((r) => r.url.endsWith('/laps'))
        .forEach((req) =>
          req.flush({
            analyzedAt: '2026-08-14T09:00:00Z',
            laps: [
              { lapNumber: 1, lapTimeMs: 92000, isBest: true },
              { lapNumber: 2, lapTimeMs: 93000, isBest: false },
            ],
          }),
        );
      http.match(() => true).forEach((req) => req.flush({ points: [] }));
      TestBed.tick();
      await Promise.resolve();

      // Back to the default: the new session's best lap is the reference again.
      service.select(2);
      expect(service.referenceLap()).toBe(1);
    });

    it('holds no "optimal" ref on a session that has no optimal lap', async () => {
      // Both pickers only render the Optimal option while `optimal()` is
      // non-null, and per-option `selected` is the only thing positioning the
      // control — so a ref with no matching option leaves the browser showing
      // the first one. The picker would read "Lap 1" while the view still
      // asked `/optimal/trace` for its line.
      await openWithLaps({ withOptimal: false });

      service.selectRef('optimal');
      service.setCompare('optimal');
      TestBed.tick();

      http.expectNone((r) => r.url.endsWith('/optimal/trace'));
      expect(service.activeLap()).toBe(1);
      expect(service.referenceLap()).toBeNull();

      http.match(() => true).forEach((req) => req.flush({ points: [] }));
      TestBed.tick();
      await Promise.resolve();
    });

    it('reports trace loading while either trace request is in flight', async () => {
      service.open('session-1');
      TestBed.tick();

      // Laps resolve first — activeLap only becomes known once bestLap is.
      http
        .match((r) => r.url.endsWith('/laps'))
        .forEach((req) =>
          req.flush({
            analyzedAt: '2026-08-14T09:00:00Z',
            laps: [{ lapNumber: 1, lapTimeMs: 92000, isBest: true }],
          }),
        );
      TestBed.tick();
      await Promise.resolve();

      // The trace requests are now in flight, ahead of their responses.
      expect(service.traceLoading()).toBe(true);

      // The trace resource's own HTTP call dispatches a tick behind isLoading
      // flipping true, so it is not yet in the mock backend's queue here.
      TestBed.tick();
      await Promise.resolve();

      http
        .match(() => true)
        .forEach((req) => req.flush({ points: [] }, { status: 404, statusText: 'Not Found' }));
      TestBed.tick();
      await Promise.resolve();

      expect(service.traceLoading()).toBe(false);
    });
  });

  describe('recompute()', () => {
    it('does nothing without an open session', async () => {
      await expect(service.recompute()).resolves.toBeUndefined();
      http.expectNone(() => true);
    });

    it('posts to /analyze then reloads laps and traces', async () => {
      service.open('session-1');
      TestBed.tick();
      http
        .match(() => true)
        .forEach((req) => req.flush({ points: [] }, { status: 404, statusText: 'Not Found' }));
      TestBed.tick();
      await Promise.resolve();

      const recomputePromise = service.recompute();
      const analyzeReq = http.expectOne((r) => r.url.endsWith('/session-1/analyze'));
      expect(analyzeReq.request.method).toBe('POST');
      analyzeReq.flush({ analyzedAt: '2026-08-14T10:00:00Z', laps: [] });
      await recomputePromise;

      // reload() re-fires every resource this view reads.
      TestBed.tick();
      const reloaded = http.match(() => true);
      expect(reloaded.length).toBeGreaterThan(0);
      reloaded.forEach((req) =>
        req.flush({ points: [] }, { status: 404, statusText: 'Not Found' }),
      );
    });
  });
});
