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
  });

  describe('selection and comparison', () => {
    const openWithLaps = async () => {
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

      http.match(() => true).forEach((req) => req.flush({ points: [] }, { status: 404, statusText: 'Not Found' }));
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
      http.match(() => true).forEach((req) => req.flush({ points: [] }, { status: 404, statusText: 'Not Found' }));
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
      reloaded.forEach((req) => req.flush({ points: [] }, { status: 404, statusText: 'Not Found' }));
    });
  });
});
